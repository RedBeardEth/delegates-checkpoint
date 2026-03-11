import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Checkpoint, { starknet, createGetLoader, LogLevel } from '@snapshot-labs/checkpoint';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import * as writer from './writer';
import config from './config.json';
import Token from './abis/Token.json';
import Token2 from './abis/Token2.json';

const dir = __dirname.endsWith('dist/src') ? '../' : '';
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, 'utf8');

const PRODUCTION_INDEXER_DELAY = 60 * 1000;
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

if (process.env.CA_CERT) {
  process.env.CA_CERT = process.env.CA_CERT.replace(/\\n/g, '\n');
}

config.network_node_url = process.env.NETWORK_NODE_URL ?? config.network_node_url;

const indexer = new starknet.StarknetIndexer(writer);
const checkpoint = new Checkpoint(config, indexer, schema, {
  logLevel: LogLevel.Info,
  resetOnConfigChange: true,
  prettifyLogs: process.env.NODE_ENV !== 'production',
  abis: { Token, Token2 }
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const INTERNAL_TABLES = ['_metadatas', '_checkpoints', '_template_sources'];
const ENTITY_TABLES = ['governances', 'delegates'];

async function bootstrapCheckpointIfNeeded() {
  const { knex } = checkpoint.getBaseContext();
  const missingInternalTables: string[] = [];
  const missingEntityTables: string[] = [];

  for (const table of INTERNAL_TABLES) {
    const exists = await knex.schema.hasTable(table);

    if (!exists) {
      missingInternalTables.push(table);
    }
  }

  for (const table of ENTITY_TABLES) {
    const exists = await knex.schema.hasTable(table);

    if (!exists) {
      missingEntityTables.push(table);
    }
  }

  if (missingInternalTables.length === 0 && missingEntityTables.length === 0) {
    return;
  }

  if (missingInternalTables.length === INTERNAL_TABLES.length) {
    console.log('Bootstrapping Checkpoint tables...');
    await checkpoint.resetMetadata();
    await checkpoint.reset();
    return;
  }

  const missingTables = [...missingInternalTables, ...missingEntityTables];
  if (missingTables.length > 0) {
    throw new Error(
      `Checkpoint database is partially initialized. Missing tables: ${missingTables.join(
        ', '
      )}. Reset the database before restarting the indexer.`
    );
  }
}

async function run() {
  const server = new ApolloServer({
    schema: checkpoint.getSchema(),
    plugins: [ApolloServerPluginLandingPageLocalDefault({ footer: false })],
    introspection: true
  });

  const { url } = await startStandaloneServer(server, {
    listen: { port: PORT },
    context: async () => {
      const baseContext = checkpoint.getBaseContext();
      return {
        ...baseContext,
        getLoader: createGetLoader(baseContext)
      };
    }
  });

  console.log(`Listening at ${url}`);

  if (process.env.NODE_ENV === 'production') {
    console.log('Delaying indexer to prevent multiple processes indexing at the same time.');
    await sleep(PRODUCTION_INDEXER_DELAY);
  }

  await bootstrapCheckpointIfNeeded();
  console.log('Checkpoint ready');

  await checkpoint.start();
}

run();
