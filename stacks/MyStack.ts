import path from "path";
import fs from "fs-extra";
import * as sst from "@serverless-stack/resources";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { aws_secretsmanager } from "aws-cdk-lib";

export default class MyStack extends sst.Stack {
  constructor(scope: sst.App, id: string, props?: sst.StackProps) {
    super(scope, id, props);

    if (!scope.local) {
      this.createPrismaLayer();
    }

    const { databaseInstance, databaseUrl } = this.createDatabase();

    // Create a HTTP API
    const api = new sst.Api(this, "Api", {
      defaultFunctionProps: {
        environment: {
          DATABASE_URL: scope.local
            ? (process.env.DATABASE_URL as string)
            : databaseUrl,
        },
        bundle: {
          // Only reference external modules when deployed
          externalModules: scope.local ? [] : ["@prisma/client", ".prisma"],
        },
      },
      routes: {
        "GET /": "src/lambda.handler",
      },
    });

    // Show the endpoint in the output
    this.addOutputs({
      ApiEndpoint: api.url,
      DbEndpoint: databaseInstance.dbInstanceEndpointAddress,
      DbPort: databaseInstance.dbInstanceEndpointPort,
    });
  }

  createDatabase() {
    const vpc = new ec2.Vpc(this, "PrismaTestVPC");

    const databaseUser = "postgres";
    const databasePassword = aws_secretsmanager.Secret.fromSecretNameV2(
      this,
      "DatabasePassword",
      "postgres-password"
    );
    const databaseName = "prismatestdb";

    const databaseInstance = new rds.DatabaseInstance(this, "PrismaTestDB", {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      databaseName,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13_4,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      credentials: {
        username: databaseUser,
        password: databasePassword.secretValue,
      },
      allocatedStorage: 10,
      publiclyAccessible: true,
    });

    databaseInstance.connections.allowDefaultPortFromAnyIpv4();

    const databaseUrl = `postgres://${databaseUser}:${databasePassword.secretValue.toString()}@${
      databaseInstance.dbInstanceEndpointAddress
    }/${databaseName}?schema=public`;

    return { databaseInstance, databaseUrl };
  }

  createPrismaLayer() {
    // Create a layer for production
    // This saves shipping Prisma binaries once per function
    const layerPath = ".sst/layers/prisma";

    // Clear out the layer path
    fs.removeSync(layerPath);
    fs.mkdirSync(layerPath, { recursive: true });

    // Copy files to the layer
    const toCopy = [
      "node_modules/.prisma",
      "node_modules/@prisma/client",
      "node_modules/prisma/build",
    ];
    for (const file of toCopy) {
      fs.copySync(file, path.join(layerPath, "nodejs", file), {
        // Do not include binary files that aren't for AWS to save space
        filter: (src) => !src.endsWith("so.node") || src.includes("rhel"),
      });
    }

    const prismaLayer = new lambda.LayerVersion(this, "PrismaLayer", {
      code: lambda.Code.fromAsset(path.resolve(layerPath)),
    });

    // Add to all functions in this stack
    this.addDefaultFunctionLayers([prismaLayer]);
  }
}
