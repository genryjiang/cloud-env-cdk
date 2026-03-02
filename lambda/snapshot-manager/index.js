const { EC2Client, CreateSnapshotCommand, DeleteVolumeCommand, DeleteSnapshotCommand, DescribeVolumesCommand, DescribeSnapshotsCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ec2 = new EC2Client();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const detail = event.detail;
  const instanceId = detail['instance-id'];
  const state = detail.state;

  try {
    if (state === 'stopped') {
      await handleInstanceStopped(instanceId);
    } else if (state === 'terminated') {
      await handleInstanceTerminated(instanceId);
    }
  } catch (error) {
    console.error('Error:', error);
  }
};

async function handleInstanceStopped(instanceId) {
  console.log(`Instance ${instanceId} stopped, creating snapshot and deleting volume`);

  const volumes = await ec2.send(new DescribeVolumesCommand({
    Filters: [
      { Name: 'attachment.instance-id', Values: [instanceId] },
      { Name: 'attachment.device', Values: ['/dev/xvda'] }
    ]
  }));

  if (!volumes.Volumes || volumes.Volumes.length === 0) {
    console.log('No volumes found for instance');
    return;
  }

  const volume = volumes.Volumes[0];
  const volumeId = volume.VolumeId;

  const snapshot = await ec2.send(new CreateSnapshotCommand({
    VolumeId: volumeId,
    Description: `Devbox snapshot for ${instanceId}`,
    TagSpecifications: [{
      ResourceType: 'snapshot',
      Tags: [
        { Key: 'InstanceId', Value: instanceId },
        { Key: 'ManagedBy', Value: 'devbox-snapshot-manager' },
        { Key: 'CreatedAt', Value: new Date().toISOString() }
      ]
    }]
  }));

  console.log(`Created snapshot ${snapshot.SnapshotId} for volume ${volumeId}`);

  const userId = volume.Tags?.find(t => t.Key === 'User')?.Value || 'unknown';
  await ddb.send(new UpdateCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
    UpdateExpression: 'SET snapshotId = :sid, volumeId = :vid, snapshotCreatedAt = :ts',
    ExpressionAttributeValues: {
      ':sid': snapshot.SnapshotId,
      ':vid': volumeId,
      ':ts': new Date().toISOString()
    }
  }));

  console.log('Waiting for snapshot to complete...');
  await waitForSnapshot(snapshot.SnapshotId);

  await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
  console.log(`Deleted volume ${volumeId}`);
}

async function handleInstanceTerminated(instanceId) {
  console.log(`Instance ${instanceId} terminated, cleaning up snapshots`);

  const snapshots = await ec2.send(new DescribeSnapshotsCommand({
    Filters: [
      { Name: 'tag:InstanceId', Values: [instanceId] },
      { Name: 'tag:ManagedBy', Values: ['devbox-snapshot-manager'] }
    ]
  }));

  for (const snapshot of snapshots.Snapshots || []) {
    console.log(`Deleting snapshot ${snapshot.SnapshotId}`);
    await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshot.SnapshotId }));
  }

  const volumes = await ec2.send(new DescribeVolumesCommand({
    Filters: [
      { Name: 'attachment.instance-id', Values: [instanceId] }
    ]
  }));

  const userId = volumes.Volumes?.[0]?.Tags?.find(t => t.Key === 'User')?.Value;
  if (userId) {
    const user = await ddb.send(new GetCommand({
      TableName: process.env.USER_TABLE,
      Key: { userId }
    }));

    if (user.Item?.snapshotId) {
      await ddb.send(new UpdateCommand({
        TableName: process.env.USER_TABLE,
        Key: { userId },
        UpdateExpression: 'REMOVE snapshotId, volumeId, snapshotCreatedAt'
      }));
      console.log(`Cleaned up DynamoDB entry for user ${userId}`);
    }
  }
}

async function waitForSnapshot(snapshotId) {
  const maxWait = 300000;
  const interval = 10000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    const result = await ec2.send(new DescribeSnapshotsCommand({
      SnapshotIds: [snapshotId]
    }));

    const snapshot = result.Snapshots[0];
    if (snapshot.State === 'completed') {
      console.log(`Snapshot ${snapshotId} completed`);
      return;
    }

    console.log(`Snapshot ${snapshotId} progress: ${snapshot.Progress}`);
    await new Promise(resolve => setTimeout(resolve, interval));
    elapsed += interval;
  }

  throw new Error(`Snapshot ${snapshotId} did not complete within 5 minutes`);
}
