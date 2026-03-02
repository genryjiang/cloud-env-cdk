import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface DevboxLifecycleProps {
  userTable: dynamodb.Table;
}

export class DevboxLifecycle extends Construct {
  constructor(scope: Construct, id: string, props: DevboxLifecycleProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'CleanupLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const cleanupFunction = new lambda.Function(this, 'Cleanup', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { EC2Client, DescribeInstancesCommand, StopInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
        const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');

        const ec2 = new EC2Client();
        const cw = new CloudWatchClient();

        exports.handler = async () => {
          const instances = await ec2.send(new DescribeInstancesCommand({
            Filters: [
              { Name: 'tag:ManagedBy', Values: ['devbox-provisioner'] },
              { Name: 'instance-state-name', Values: ['running'] }
            ]
          }));

          for (const reservation of instances.Reservations || []) {
            for (const instance of reservation.Instances || []) {
              const age = (Date.now() - new Date(instance.LaunchTime).getTime()) / (1000 * 60 * 60);

              if (age < 1.5) {
                console.log('Skipping instance (too new):', instance.InstanceId, 'age:', age.toFixed(2), 'hours');
                continue;
              }

              const idle = await checkIdle(instance.InstanceId, 1);
              const ageDays = age / 24;

              if (idle) {
                console.log('Stopping idle instance (1h idle):', instance.InstanceId);
                await ec2.send(new StopInstancesCommand({ InstanceIds: [instance.InstanceId] }));
              } else if (ageDays > 7) {
                console.log('Stopping old instance (>7 days):', instance.InstanceId);
                await ec2.send(new StopInstancesCommand({ InstanceIds: [instance.InstanceId] }));
              }
            }
          }
        };

        async function checkIdle(instanceId, hours) {
          const result = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: new Date(Date.now() - hours * 60 * 60 * 1000),
            EndTime: new Date(),
            Period: 3600,
            Statistics: ['Average']
          }));

          if (!result.Datapoints || result.Datapoints.length === 0) {
            console.log('No metrics available for', instanceId, '- not considering idle');
            return false;
          }

          const avg = result.Datapoints.reduce((sum, dp) => sum + dp.Average, 0) / result.Datapoints.length;
          console.log('Instance', instanceId, 'avg CPU:', avg.toFixed(2) + '%', 'datapoints:', result.Datapoints.length);
          return avg < 5;
        }
      `),
      timeout: Duration.minutes(5),
      logGroup,
    });

    cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    new events.Rule(this, 'CleanupSchedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(cleanupFunction)],
    });

    const snapshotManagerLogGroup = new logs.LogGroup(this, 'SnapshotManagerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const snapshotManagerFunction = new lambda.Function(this, 'SnapshotManager', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/snapshot-manager'),
      timeout: Duration.minutes(10),
      logGroup: snapshotManagerLogGroup,
      environment: {
        USER_TABLE: props.userTable.tableName,
      },
    });

    snapshotManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeVolumes',
        'ec2:CreateSnapshot',
        'ec2:DeleteVolume',
        'ec2:DescribeSnapshots',
        'ec2:DeleteSnapshot',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));

    props.userTable.grantReadWriteData(snapshotManagerFunction);

    new events.Rule(this, 'SnapshotOnStop', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['stopped', 'terminated'],
        },
      },
      targets: [new targets.LambdaFunction(snapshotManagerFunction)],
    });
  }
}
