import configFactory from './vercel-config.cjs';

export const config = configFactory.createVercelConfig(process.env);
