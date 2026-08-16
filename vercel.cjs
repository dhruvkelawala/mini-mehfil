const { createVercelConfig } = require('./vercel-config.cjs');

exports.config = createVercelConfig(process.env);
