require('dotenv').config();
const poster = require('./src/poster');

// Reply to tweet 4 (last tweet in thread after Ian deleted tweet 5)
const PARENT = 'https://x.com/CardanoWT/status/2031086213889728796';

const text = 'Our finding can be found here: https://github.com/Cardano-Watch-Tower/watchers/tree/main/investigations/genesis-trace. Should we dig further?\n\nAlways Watching \ud83d\udc41\ufe0f';

poster.replyToTweet(PARENT, text).then(() => {
  console.log('Done');
  process.exit(0);
}).catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
