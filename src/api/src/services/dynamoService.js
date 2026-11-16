import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, config } from '../config/aws.js';

export const VIDEO_ENTITY_TYPE = 'VIDEO';

/**
 * Tạo bản ghi video mới với trạng thái ban đầu UPLOADING
 * @param {Object} videoData
 */
export async function createVideoRecord(videoData) {
  const timestamp = new Date().toISOString();
  const item = {
    videoId: videoData.videoId,
    // Partition key cố định của GSI createdAt, để liệt kê video mới nhất trước
    entityType: VIDEO_ENTITY_TYPE,
    title: videoData.title || 'Untitled Video',
    description: videoData.description || '',
    originalFileName: videoData.originalFileName,
    contentType: videoData.contentType || 'video/mp4',
    tier: videoData.tier || 'free', // 'free' or 'premium'
    status: 'UPLOADING', // UPLOADING -> PROCESSING -> READY -> FAILED
    rawS3Key: videoData.rawS3Key,
    rawBucket: config.rawBucket,
    processedBucket: config.processedBucket,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await docClient.send(
    new PutCommand({
      TableName: config.videosTable,
      Item: item,
    })
  );

  return item;
}

/**
 * Cập nhật trạng thái và các trường dữ liệu bổ sung của video
 * @param {string} videoId
 * @param {string} status 'PROCESSING' | 'READY' | 'FAILED'
 * @param {Object} extraFields (qualities, masterPlaylistUrl, duration, errorMessage...)
 * @param {{ expectedStatus?: string, notStatus?: string }} options Điều kiện trên status hiện tại:
 *   expectedStatus phải khớp, notStatus phải khác. Khi có điều kiện, video cũng phải tồn tại
 *   (ngược lại DynamoDB ném ConditionalCheckFailedException)
 */
export async function updateVideoStatus(videoId, status, extraFields = {}, options = {}) {
  const timestamp = new Date().toISOString();

  const updateExpParts = ['#status = :status', '#updatedAt = :updatedAt'];
  const expAttrNames = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const expAttrValues = {
    ':status': status,
    ':updatedAt': timestamp,
  };

  for (const [key, value] of Object.entries(extraFields)) {
    if (value !== undefined) {
      updateExpParts.push(`#${key} = :${key}`);
      expAttrNames[`#${key}`] = key;
      expAttrValues[`:${key}`] = value;
    }
  }

  const conditions = [];
  if (options.expectedStatus) {
    conditions.push('#status = :expectedStatus');
    expAttrValues[':expectedStatus'] = options.expectedStatus;
  }
  if (options.notStatus) {
    conditions.push('#status <> :notStatus');
    expAttrValues[':notStatus'] = options.notStatus;
  }
  const conditionExpression = conditions.length
    ? ['attribute_exists(videoId)', ...conditions].join(' AND ')
    : undefined;

  const response = await docClient.send(
    new UpdateCommand({
      TableName: config.videosTable,
      Key: { videoId },
      UpdateExpression: `SET ${updateExpParts.join(', ')}`,
      ExpressionAttributeNames: expAttrNames,
      ExpressionAttributeValues: expAttrValues,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
      ReturnValues: 'ALL_NEW',
    })
  );

  return response.Attributes;
}

/**
 * Lấy thông tin chi tiết một video theo ID
 * @param {string} videoId
 */
export async function getVideoById(videoId) {
  const response = await docClient.send(
    new GetCommand({
      TableName: config.videosTable,
      Key: { videoId },
    })
  );

  return response.Item || null;
}

/**
 * Liệt kê video mới nhất trước, có phân trang, qua GSI (entityType, createdAt).
 * Limit của DynamoDB áp dụng trước FilterExpression, nên khi lọc theo status
 * một trang có thể ít hơn `limit` phần tử dù vẫn còn trang sau (xem lastKey).
 * @param {{ limit: number, startKey?: Object, status?: string }} options
 * @returns {Promise<{ items: Object[], lastKey: Object | undefined }>}
 */
export async function listVideos({ limit, startKey, status }) {
  const response = await docClient.send(
    new QueryCommand({
      TableName: config.videosTable,
      IndexName: config.videosByCreatedAtIndex,
      KeyConditionExpression: '#entityType = :entityType',
      ...(status ? { FilterExpression: '#status = :status' } : {}),
      ExpressionAttributeNames: {
        '#entityType': 'entityType',
        ...(status ? { '#status': 'status' } : {}),
      },
      ExpressionAttributeValues: {
        ':entityType': VIDEO_ENTITY_TYPE,
        ...(status ? { ':status': status } : {}),
      },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: startKey,
    })
  );

  return { items: response.Items || [], lastKey: response.LastEvaluatedKey };
}

/**
 * Xóa bản ghi video
 * @param {string} videoId
 */
export async function deleteVideoRecord(videoId) {
  await docClient.send(
    new DeleteCommand({
      TableName: config.videosTable,
      Key: { videoId },
    })
  );
  return { success: true, videoId };
}
