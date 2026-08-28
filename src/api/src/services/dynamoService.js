import {
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, config } from '../config/aws.js';

/**
 * Tạo bản ghi video mới với trạng thái ban đầu UPLOADING
 * @param {Object} videoData
 */
export async function createVideoRecord(videoData) {
  const timestamp = new Date().toISOString();
  const item = {
    videoId: videoData.videoId,
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
 */
export async function updateVideoStatus(videoId, status, extraFields = {}) {
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

  const response = await docClient.send(
    new UpdateCommand({
      TableName: config.videosTable,
      Key: { videoId },
      UpdateExpression: `SET ${updateExpParts.join(', ')}`,
      ExpressionAttributeNames: expAttrNames,
      ExpressionAttributeValues: expAttrValues,
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
 * Lấy danh sách toàn bộ video (sắp xếp theo createdAt mới nhất)
 * @param {number} limit
 */
export async function getAllVideos(limit = 50) {
  const response = await docClient.send(
    new ScanCommand({
      TableName: config.videosTable,
      Limit: limit,
    })
  );

  const items = response.Items || [];
  // Sắp xếp bài mới nhất lên đầu
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
