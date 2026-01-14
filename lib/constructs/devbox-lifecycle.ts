import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export class DevboxLifecycle extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const cleanupFunction = new lambda.Function(this, 'Cleanup', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'provision.handler',
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
              const idle = await checkIdle(instance.InstanceId, 2); // 2 hours
              const age = (Date.now() - new Date(instance.LaunchTime).getTime()) / (1000 * 60 * 60 * 24);

              if (idle) {
                console.log('Stopping idle instance:', instance.InstanceId);
                await ec2.send(new StopInstancesCommand({ InstanceIds: [instance.InstanceId] }));
              } else if (age > 7) {
                console.log('Terminating old instance:', instance.InstanceId);
                await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instance.InstanceId] }));
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
          const avg = result.Datapoints?.reduce((sum, dp) => sum + dp.Average, 0) / (result.Datapoints?.length || 1);
          return avg < 5; // Less than 5% CPU
        }
      `),
      timeout: Duration.minutes(5),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));

    new events.Rule(this, 'CleanupSchedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(cleanupFunction)],
    });
  }
}
