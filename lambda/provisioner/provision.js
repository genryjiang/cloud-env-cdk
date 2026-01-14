const { EC2Client, RunInstancesCommand, DescribeInstancesCommand, StopInstancesCommand, TerminateInstancesCommand, StartInstancesCommand } = require('@aws-sdk/client-ec2');
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
      // Restart stopped instance
      await ec2.send(new StartInstancesCommand({ InstanceIds: [existing.Item.instanceId] }));
      return {
        statusCode: 200,
        body: JSON.stringify({ instanceId: existing.Item.instanceId, status: 'starting' }),
      };
    }
  }

  const subnets = process.env.SUBNET_IDS.split(',');
  const result = await ec2.send(new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateId: process.env.LAUNCH_TEMPLATE_ID },
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnets[0],
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
