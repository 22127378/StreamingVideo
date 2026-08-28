import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, config } from '../config/aws.js';

/**
 * Cập nhật trạng thái và metadata của video vào DynamoDB
 * @param {string} videoId
 * @param {string} status 'PROCESSING' | 'READY' | 'FAILED'
 * @param {Object} extraFields (qualities, masterPlaylistUrl, duration, thumbnailUrl, errorMessage...)
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

  console.log(`🗄️ [DynamoDB] Cập nhật Video ${videoId} -> Status: [${status}]`);
  return response.Attributes;
}
