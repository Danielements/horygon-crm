const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..', '..');

function loadIfExists(fileName, override = false) {
  const fullPath = path.join(projectRoot, fileName);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override });
  }
}

loadIfExists('.env');

const nodeEnv = process.env.NODE_ENV || 'development';
loadIfExists(`.env.${nodeEnv}`, true);

if (nodeEnv !== 'production') {
  loadIfExists('.env.local', true);
}

module.exports = { projectRoot, nodeEnv };
