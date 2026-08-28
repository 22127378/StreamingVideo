import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClient, config } from '../config/aws.js';

/**
 * Gửi thông điệp transcode job vào SQS Queue cho Worker tiêu thụ
 * @param {Object} jobData
 * @returns {Promise<{ messageId: string, queueUrl: string }>}
 */
export async function sendTranscodeJob(jobData) {
  const payload = {
    eventType: 'VIDEO_UPLOAD_COMPLETED',
    videoId: jobData.videoId,
    title: jobData.title,
    rawBucket: jobData.rawBucket || config.rawBucket,
    rawS3Key: jobData.rawS3Key,
    processedBucket: jobData.processedBucket || config.processedBucket,
    targetResolutions: jobData.targetResolutions || ['1080p', '720p', '480p', '360p'],
    requestedAt: new Date().toISOString(),
  };

  const command = new SendMessageCommand({
    QueueUrl: config.transcodeQueueUrl,
    MessageBody: JSON.stringify(payload),
    MessageAttributes: {
      VideoId: {
        DataType: 'String',
        StringValue: jobData.videoId,
      },
      EventType: {
        DataType: 'String',
        StringValue: 'VIDEO_TRANSCODE_REQUEST',
      },
    },
  });

  const response = await sqsClient.send(command);

  return {
    messageId: response.MessageId,
    queueUrl: config.transcodeQueueUrl,
    payload,
  };
}
