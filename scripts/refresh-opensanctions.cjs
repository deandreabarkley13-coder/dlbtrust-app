'use strict';

require('dotenv').config();

const { OpenSanctionsListEngine } = require('../server/integrations/compliance/openSanctionsListEngine');

OpenSanctionsListEngine.refresh()
  .then((status) => {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.ready ? 0 : 1);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
