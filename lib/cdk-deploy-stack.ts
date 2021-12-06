import * as cdk from '@aws-cdk/core';
// import * as sqs from '@aws-cdk/aws-sqs';
import { Artifact, Pipeline } from '@aws-cdk/aws-codepipeline';
import {
  CodeBuildAction,
  GitHubSourceAction,
  GitHubTrigger,
  S3DeployAction,
} from '@aws-cdk/aws-codepipeline-actions';
import { Duration, RemovalPolicy, SecretValue } from '@aws-cdk/core';
import { BuildSpec, PipelineProject } from '@aws-cdk/aws-codebuild';
import { Bucket } from '@aws-cdk/aws-s3';
import * as dotenv from 'dotenv';
import { ArnPrincipal, CanonicalUserPrincipal, Effect, PolicyStatement } from '@aws-cdk/aws-iam';
import {
  CloudFrontWebDistribution,
  OriginAccessIdentity,
  PriceClass,
} from '@aws-cdk/aws-cloudfront';

dotenv.config();

export class CdkDeployStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 参考
    // https://blog.foresta.me/posts/blog-deploy-pipeline/
    // https://dev.classmethod.jp/articles/s3-cloudfront-cdk-content-distribution/

    const sourceOutput = new Artifact();
    const sourceAction = new GitHubSourceAction({
      actionName: 'GitHubAction',
      output: sourceOutput,
      repo: process.env.SOURCE_ACTION_REPO || '',
      owner: process.env.SOURCE_ACTION_OWNER || '',
      branch: 'main',
      trigger: GitHubTrigger.POLL,
      oauthToken: cdk.SecretValue.plainText(process.env.SOURCE_ACTION_GITHUB_TOKEN || ''),
    });

    const buildProject = new PipelineProject(this, 'BuildProject', {
      projectName: 'BuildProject',
      buildSpec: BuildSpec.fromSourceFilename('buildspec.yml'),
    });
    const buildArtifact = new Artifact();
    const buildAction = new CodeBuildAction({
      actionName: 'BuildAction',
      input: sourceOutput,
      project: buildProject,
      outputs: [buildArtifact],
      environmentVariables: {
        REACT_APP_WEB_SOCKET_URL: { value: process.env.REACT_APP_WEB_SOCKET_URL },
      },
    });

    const bucket = new Bucket(this, 'ServerlessChatAppBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const oai = new OriginAccessIdentity(this, 'OriginAccessIdentity');
    const bucketPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
      resources: [bucket.bucketArn + '/*'],
    });
    bucket.addToResourcePolicy(bucketPolicy);

    const deployAction = new S3DeployAction({
      actionName: 'ServerlessChatAppDeployAction',
      bucket: bucket,
      input: buildArtifact,
    });

    const pipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: 'Pipeline',
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        { stageName: 'Build', actions: [buildAction] },
        { stageName: 'Deploy', actions: [deployAction] },
        // { stageName: 'Invalidate', actions: [] },
      ],
    });

    new CloudFrontWebDistribution(this, 'WebsiteDistribution', {
      originConfigs: [
        {
          behaviors: [
            {
              isDefaultBehavior: true,
              minTtl: Duration.seconds(0),
              maxTtl: Duration.days(365),
              defaultTtl: Duration.days(1),
              pathPattern: '*',
            },
          ],
          s3OriginSource: {
            s3BucketSource: bucket,
            originAccessIdentity: oai,
          },
        },
      ],
      viewerCertificate: { aliases: [], props: { cloudFrontDefaultCertificate: true } },
      priceClass: PriceClass.PRICE_CLASS_ALL,
      errorConfigurations: [
        {
          errorCode: 403,
          responsePagePath: '/index.html',
          responseCode: 200,
          errorCachingMinTtl: 0,
        },
        {
          errorCode: 404,
          responsePagePath: '/index.html',
          responseCode: 200,
          errorCachingMinTtl: 0,
        },
      ],
    });
  }
}
