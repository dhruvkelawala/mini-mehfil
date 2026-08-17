import process from 'node:process';

import { createVercelConfig } from './src/server/vercel-config.ts';

export const config = createVercelConfig(process.env);
