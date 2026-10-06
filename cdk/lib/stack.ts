import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as kms from "aws-cdk-lib/aws-kms";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import * as iam from "aws-cdk-lib/aws-iam";

interface Props extends cdk.StackProps {
  projectName: string;
  envName: string;
}

export class ServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { projectName: p, envName: e } = props;
    const prefix = `${p}-${e}`;

    // ── SSM から Terraform 出力を参照 ──────────────────────
    const tableArn  = ssm.StringParameter.valueForStringParameter(this, `/${p}/${e}/dynamodb/table_arn`);
    const tableName = ssm.StringParameter.valueForStringParameter(this, `/${p}/${e}/dynamodb/table_name`);
    const kmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `/${p}/${e}/kms/key_arn`);
    const logGroupName = ssm.StringParameter.valueForStringParameter(this, `/${p}/${e}/cloudwatch/lambda_log_group`);

    const cmk = kms.Key.fromKeyArn(this, "ImportedCmk", kmsKeyArn);
    const table = dynamodb.Table.fromTableArn(this, "ImportedTable", tableArn);
    const logGroup = logs.LogGroup.fromLogGroupName(this, "ImportedLg", logGroupName);

    // ── Lambda IAM Role (最小権限) ─────────────────────────
    const lambdaRole = new iam.Role(this, "LambdaRole", {
      roleName: `${prefix}-lambda-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      resources: [tableArn, `${tableArn}/index/*`],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["kms:GenerateDataKey*", "kms:Decrypt"],
      resources: [kmsKeyArn],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      resources: ["*"],
    }));

    // ── Lambda Function ───────────────────────────────────
    const handler = new lambda.Function(this, "Handler", {
      functionName: `${prefix}-handler`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        TABLE_NAME: tableName,
        ENV:        e,
        POWERTOOLS_SERVICE_NAME: prefix,
        LOG_LEVEL: e === "prd" ? "INFO" : "DEBUG",
      },
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  console.log(JSON.stringify({ message: "request", path: event.rawPath, method: event.requestContext?.http?.method }));
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ok" }) };
};`),
    });

    // ── SNS Alert Topic ───────────────────────────────────
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: `${prefix}-alerts`,
      masterKey: cmk,
    });

    // ── API Gateway HTTP API ───────────────────────────────
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${prefix}-api`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ["Content-Type", "Authorization"],
        maxAge: cdk.Duration.days(1),
      },
      defaultThrottlingBurstLimit:  500,
      defaultThrottlingRateLimit:  1000,
    });
    api.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration("LambdaIntegration", handler),
    });

    // ── CloudWatch Alarms ─────────────────────────────────
    const alarmProps = (id: string, metric: cloudwatch.Metric, threshold: number): cloudwatch.Alarm =>
      new cloudwatch.Alarm(this, id, {
        metric, threshold,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmName: `${prefix}-${id}`,
      });

    alarmProps("LambdaErrors",     handler.metricErrors({ period: cdk.Duration.minutes(5) }),     5);
    alarmProps("LambdaThrottles",  handler.metricThrottles({ period: cdk.Duration.minutes(5) }),  10);

    // ── Outputs ───────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiEndpoint",    { value: api.apiEndpoint,        exportName: `${prefix}-api-endpoint` });
    new cdk.CfnOutput(this, "LambdaArn",      { value: handler.functionArn,    exportName: `${prefix}-lambda-arn` });
    new cdk.CfnOutput(this, "AlertTopicArn",  { value: alertTopic.topicArn,    exportName: `${prefix}-alert-topic-arn` });
  }
}