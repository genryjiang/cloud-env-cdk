const { EC2Client, RunInstancesCommand, DescribeInstancesCommand, StopInstancesCommand, TerminateInstancesCommand, StartInstancesCommand, DescribeVolumesCommand, CreateVolumeCommand, AttachVolumeCommand, DescribeSnapshotsCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const ec2 = new EC2Client();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const body = event.body ? JSON.parse(event.body) : event.queryStringParameters || {};
    const { action, userId } = body;

    if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId required' }) };
    }

    switch (action) {
      case 'provision':
        return await provisionDevbox(userId);
      case 'status':
        return await getDevboxStatus(userId);
      case 'stop':
        return await stopDevbox(userId);
      case 'terminate':
        return await terminateDevbox(userId);
      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message, stack: error.stack })
    };
  }
};

async function provisionDevbox(userId) {
  const existing = await ddb.send(new GetCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
  }));

  if (existing.Item?.instanceId) {
    const status = await checkInstanceStatus(existing.Item.instanceId);
    if (status === 'running' || status === 'pending') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          instanceId: existing.Item.instanceId,
          status,
          message: 'Devbox already exists'
        }),
      };
    } else if (status === 'stopped') {
      // Check if we need to restore from snapshot
      await restoreVolumeFromSnapshot(existing.Item.instanceId, existing.Item.snapshotId);
      await ec2.send(new StartInstancesCommand({ InstanceIds: [existing.Item.instanceId] }));
      return {
        statusCode: 200,
        body: JSON.stringify({ instanceId: existing.Item.instanceId, status: 'starting' }),
      };
    }
  }

  const subnets = process.env.SUBNET_IDS.split(',');
  const result = await ec2.send(new RunInstancesCommand({
    LaunchTemplate: {
      LaunchTemplateId: process.env.LAUNCH_TEMPLATE_ID,
      Version: '$Latest'
    },
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnets[0],
    SecurityGroupIds: [process.env.SECURITY_GROUP_ID],
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: `devbox-${userId}` },
        { Key: 'User', Value: userId },
        { Key: 'ManagedBy', Value: 'devbox-provisioner' },
        { Key: 'Purpose', Value: 'Devbox' },
        { Key: 'Owner', Value: userId },
      ],
    }],
  }));

  const instanceId = result.Instances[0].InstanceId;

  await ddb.send(new PutCommand({
    TableName: process.env.USER_TABLE,
    Item: {
      userId,
      instanceId,
      createdAt: new Date().toISOString(),
    },
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      instanceId,
      status: 'pending',
      message: 'Devbox provisioned. Wait 2-3 minutes before connecting.'
    }),
  };
}

async function getDevboxStatus(userId) {
  const item = await ddb.send(new GetCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
  }));

  if (!item.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No devbox found' }) };
  }

  const status = await checkInstanceStatus(item.Item.instanceId);
  return {
    statusCode: 200,
    body: JSON.stringify({ instanceId: item.Item.instanceId, status }),
  };
}

async function stopDevbox(userId) {
  const item = await ddb.send(new GetCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
  }));

  if (!item.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No devbox found' }) };
  }

  await ec2.send(new StopInstancesCommand({ InstanceIds: [item.Item.instanceId] }));
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Devbox stopping' }),
  };
}

async function terminateDevbox(userId) {
  const item = await ddb.send(new GetCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
  }));

  if (!item.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No devbox found' }) };
  }

  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [item.Item.instanceId] }));
  await ddb.send(new DeleteCommand({
    TableName: process.env.USER_TABLE,
    Key: { userId },
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Devbox terminated' }),
  };
}

async function checkInstanceStatus(instanceId) {
  try {
    const result = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }));
    return result.Reservations[0]?.Instances[0]?.State?.Name || 'unknown';
  } catch (e) {
    return 'terminated';
  }
}

async function restoreVolumeFromSnapshot(instanceId, snapshotId) {
  if (!snapshotId) {
    console.log('No snapshot found, volume should already exist');
    return;
  }

  // Check if volume already exists
  const volumes = await ec2.send(new DescribeVolumesCommand({
    Filters: [
      { Name: 'attachment.instance-id', Values: [instanceId] },
      { Name: 'attachment.device', Values: ['/dev/xvda'] }
    ]
  }));

  if (volumes.Volumes && volumes.Volumes.length > 0) {
    console.log('Volume already exists, no restoration needed');
    return;
  }

  console.log(`Restoring volume from snapshot ${snapshotId}`);

  // Get instance details for AZ
  const instances = await ec2.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId]
  }));
  const instance = instances.Reservations[0]?.Instances[0];
  const availabilityZone = instance.Placement.AvailabilityZone;

  // Create volume from snapshot
  const volume = await ec2.send(new CreateVolumeCommand({
    SnapshotId: snapshotId,
    AvailabilityZone: availabilityZone,
    VolumeType: 'gp3',
    Encrypted: true,
    TagSpecifications: [{
      ResourceType: 'volume',
      Tags: [
        { Key: 'InstanceId', Value: instanceId },
        { Key: 'ManagedBy', Value: 'devbox-provisioner' },
        { Key: 'RestoredFrom', Value: snapshotId }
      ]
    }]
  }));

  console.log(`Created volume ${volume.VolumeId} from snapshot`);

  // Wait for volume to be available
  await waitForVolume(volume.VolumeId);

  // Attach volume to instance
  await ec2.send(new AttachVolumeCommand({
    VolumeId: volume.VolumeId,
    InstanceId: instanceId,
    Device: '/dev/xvda'
  }));

  console.log(`Attached volume ${volume.VolumeId} to instance ${instanceId}`);
}

async function waitForVolume(volumeId) {
  const maxWait = 120000; // 2 minutes
  const interval = 5000; // 5 seconds
  let elapsed = 0;

  while (elapsed < maxWait) {
    const result = await ec2.send(new DescribeVolumesCommand({
      VolumeIds: [volumeId]
    }));

    const volume = result.Volumes[0];
    if (volume.State === 'available') {
      console.log(`Volume ${volumeId} is available`);
      return;
    }

    console.log(`Volume ${volumeId} state: ${volume.State}`);
    await new Promise(resolve => setTimeout(resolve, interval));
    elapsed += interval;
  }

  throw new Error(`Volume ${volumeId} did not become available within 2 minutes`);
}
