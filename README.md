<h1 align='center'>ETL-Template</h1>

<p align='center'>Template Repository for creating new ETLs</p>

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Builds are performed by the `cloudtak-etl` script provided by [`@tak-ps/etl`](https://github.com/dfpc-coe/etl-base).
It requires a `capabilities.json` document alongside the `Dockerfile` which describes the task (name, description,
compute requirements, permissions & invocation types) and is validated and embedded in the OCI Image Manifest as a
`com.cloudtak.capabilities` annotation so CloudTAK can read it directly from ECR before the task is ever deployed.
Update `capabilities.json` whenever the task's requirements change.

To build & push manually:

```sh
export AWS_REGION='us-east-1'
export AWS_ACCOUNT_ID='123456789012'
export Environment='prod' # Optional - defaults to prod

npx cloudtak-etl
```

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.
