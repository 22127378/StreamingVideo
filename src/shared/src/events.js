// Sự kiện giữa các service, đi qua một EventBridge bus (EVENT_BUS_NAME).
//
// Service phát sự kiện bằng publishEvent(); EventBridge chuyển theo rule tới SQS của service nhận:
//   VideoCreated, VideoUploaded           (upload)    -> catalog
//   VideoUploaded                          (upload)    -> hàng đợi transcode (chỉ phần detail = job)
//   TranscodeStarted/Completed/Failed      (transcode) -> catalog
//   VideoViewed                            (playback)  -> catalog
// Không service nào đọc database của service khác.
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { setTimeout as sleep } from 'node:timers/promises';
import { awsClientConfig } from './aws.js';

export const EVENT_TYPES = Object.freeze({
  VideoCreated: 'VideoCreated',
  VideoUploaded: 'VideoUploaded',
  TranscodeStarted: 'TranscodeStarted',
  TranscodeCompleted: 'TranscodeCompleted',
  TranscodeFailed: 'TranscodeFailed',
  VideoViewed: 'VideoViewed',
  VideoDeleted: 'VideoDeleted',
});

let eventBridge;

/**
 * Phát một sự kiện. source = "streamforge.<service>".
 * @param {string} service tên service phát (upload, transcode, ...)
 * @param {string} detailType một giá trị trong EVENT_TYPES
 * @param {object} detail nội dung, có videoId
 */
export async function publishEvent(service, detailType, detail, { busName = process.env.EVENT_BUS_NAME } = {}) {
  if (!busName) throw new Error('EVENT_BUS_NAME chưa được cấu hình');
  eventBridge ??= new EventBridgeClient(awsClientConfig);
  const result = await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: `streamforge.${service}`,
          DetailType: detailType,
          Detail: JSON.stringify({ ...detail, occurredAt: detail.occurredAt || new Date().toISOString() }),
        },
      ],
    })
  );
  // PutEvents trả 200 kể cả khi từng entry lỗi; phải đọc FailedEntryCount
  if (result.FailedEntryCount) {
    const entry = result.Entries?.[0] || {};
    throw new Error(`Không phát được sự kiện ${detailType}: ${entry.ErrorCode} ${entry.ErrorMessage}`);
  }
  return result.Entries?.[0]?.EventId;
}

/** Lỗi tạm thời: để message quay lại hàng đợi và xử lý lại sau (ví dụ sự kiện đến sớm hơn VideoCreated) */
export class RetryLaterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

/**
 * Đọc sự kiện EventBridge từ một hàng đợi SQS và gọi handler cho từng sự kiện.
 * Handler xong thì xoá message; ném lỗi thì message quay lại sau retryDelaySeconds (SQS chuyển sang
 * DLQ sau maxReceiveCount lần). Handler phải idempotent: SQS có thể giao một message nhiều lần.
 * @param {{ queueUrl: string, handler: (event: { id: string, type: string, source: string, time: string, detail: object }) => Promise<void>,
 *   stopSignal?: AbortSignal, onResult?: (type: string, outcome: string) => void, retryDelaySeconds?: number }} options
 */
export async function consumeEvents({ queueUrl, handler, stopSignal, onResult = () => {}, retryDelaySeconds = 15 }) {
  const sqs = new SQSClient(awsClientConfig);
  console.log(`[events] consuming ${queueUrl}`);
  while (!stopSignal?.aborted) {
    let response;
    try {
      response = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }),
        { abortSignal: stopSignal }
      );
    } catch (err) {
      if (stopSignal?.aborted) break;
      console.warn(`[events] receive failed (${err.message}), retry in 5s`);
      await sleep(5000, undefined, { signal: stopSignal }).catch(() => {});
      continue;
    }

    for (const message of response.Messages || []) {
      let event;
      try {
        const body = JSON.parse(message.Body);
        event = { id: body.id, type: body['detail-type'], source: body.source, time: body.time, detail: body.detail || {} };
      } catch {
        console.warn('[events] message không phải sự kiện EventBridge, bỏ qua');
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        onResult('invalid', 'dropped');
        continue;
      }
      try {
        await handler(event);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        onResult(event.type, 'ok');
      } catch (err) {
        const retry = err.name === 'RetryLaterError';
        (retry ? console.warn : console.error)(`[events] ${event.type} ${event.detail?.videoId || ''}: ${err.message}`);
        onResult(event.type, retry ? 'retry' : 'error');
        await sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: retryDelaySeconds,
            })
          )
          .catch(() => {});
      }
    }
  }
  console.log('[events] stopped');
}
