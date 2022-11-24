const core = require('@actions/core');
const axios = require('axios');

async function main() {
  const jelasticUrl = core.getInput('jelastic_url');
  const jelasticToken = core.getInput('jelastic_token');
  const envName = core.getInput('jelastic_env');
  const version = core.getInput('version');
  const deployDelay = core.getInput('deploy_delay');
  const requestTimeout = Number(core.getInput('request_timeout'));

  const actionPath = 'environment/control/rest/redeploycontainersbygroup';

  core.info(`Deploying ${envName} on ${jelasticUrl} to version ${version} (delay=${deployDelay})`);

  const params = new URLSearchParams({
    session: jelasticToken,
    envName,
    tag: version,
    nodeGroup: 'cp',
    isSequential: true,
    delay: deployDelay,
  });
  const url = new URL(`https://${jelasticUrl}/1.0/${actionPath}?${params}`);
  const client = axios.create({ timeout: requestTimeout, responseType: 'json' });
  const response = await client.post(url, null);

  console.log(response);

  if (response.status !== 200) {
    throw new Error(`Jelastic did not returned a successful response: ${response}`);
  }

  const data = await response.data;

  core.setOutput('response', data);

  if (data?.result !== 0) {
    throw new Error(`Could not deploy: ${data}`);
  }
}

main()
  .catch((error) => core.setFailed(error.message));

