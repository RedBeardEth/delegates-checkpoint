import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Checkpoint, { starknet, createGetLoader, LogLevel } from '@snapshot-labs/checkpoint';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import * as writer from './writer';
import { STARKNET_INDEXER_NAME } from './constants';
import config from './config.json';
import overridesConfig from './overrides.json';
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

const checkpointConfig = {
  ...config,
  network_node_url: process.env.NETWORK_NODE_URL ?? config.network_node_url,
  abis: { Token, Token2 }
};

const checkpoint = new Checkpoint(schema, {
  logLevel: LogLevel.Info,
  resetOnConfigChange: true,
  skipBlockFetching: true,
  prettifyLogs: process.env.NODE_ENV !== 'production',
  overridesConfig
});

checkpoint.addIndexer(
  STARKNET_INDEXER_NAME,
  checkpointConfig,
  new starknet.StarknetIndexer(writer)
);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const INTERNAL_TABLES = ['_blocks', '_metadatas', '_checkpoints', '_template_sources'];
const ENTITY_TABLES = ['governances', 'delegates'];
const REQUIRED_TABLE_COLUMNS: Record<string, string[]> = {
  _blocks: ['indexer', 'block_number', 'hash'],
  _metadatas: ['id', 'indexer', 'value'],
  _checkpoints: ['id', 'indexer', 'block_number', 'contract_address'],
  _template_sources: ['indexer', 'contract_address', 'start_block', 'template'],
  governances: ['id', 'uid', '_indexer', 'block_range'],
  delegates: ['id', 'uid', '_indexer', 'block_range']
};

async function findMissingColumns(table: string): Promise<string[]> {
  const { knex } = checkpoint.getBaseContext();
  const requiredColumns = REQUIRED_TABLE_COLUMNS[table] ?? [];
  const missingColumns: string[] = [];

  for (const column of requiredColumns) {
    const exists = await knex.schema.hasColumn(table, column);

    if (!exists) {
      missingColumns.push(column);
    }
  }

  return missingColumns;
}

async function bootstrapCheckpointIfNeeded() {
  const { knex } = checkpoint.getBaseContext();
  const missingInternalTables: string[] = [];
  const missingEntityTables: string[] = [];
  const invalidTables: string[] = [];

  for (const table of INTERNAL_TABLES) {
    const exists = await knex.schema.hasTable(table);

    if (!exists) {
      missingInternalTables.push(table);
      continue;
    }

    const missingColumns = await findMissingColumns(table);

    if (missingColumns.length > 0) {
      invalidTables.push(`${table} (missing columns: ${missingColumns.join(', ')})`);
    }
  }

  for (const table of ENTITY_TABLES) {
    const exists = await knex.schema.hasTable(table);

    if (!exists) {
      missingEntityTables.push(table);
      continue;
    }

    const missingColumns = await findMissingColumns(table);

    if (missingColumns.length > 0) {
      invalidTables.push(`${table} (missing columns: ${missingColumns.join(', ')})`);
    }
  }

  if (
    missingInternalTables.length === 0 &&
    missingEntityTables.length === 0 &&
    invalidTables.length === 0
  ) {
    return;
  }

  const resetReasons = [
    ...missingInternalTables.map(table => `${table} (missing table)`),
    ...missingEntityTables.map(table => `${table} (missing table)`),
    ...invalidTables
  ];

  console.log(`Resetting Checkpoint schema: ${resetReasons.join('; ')}`);
  await checkpoint.resetMetadata();
  await checkpoint.reset();
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
