#!/usr/bin/env node
'use strict';

/**
 * PTC In-House Family Bank — Camel integration bus operator script
 *
 * The bus runs inside the server, so nothing here is required for the flow to
 * work. It exists for the two moments when the server is the wrong place to
 * stand: an operator who needs to see or unstick a single exchange, and a
 * deployment where the schedule belongs somewhere else (a cron, a Kubernetes
 * CronJob, a JVM Camel runtime) and the in-server scheduler is turned off.
 *
 *   node server/scripts/camelBus.js status
 *   node server/scripts/camelBus.js routes
 *   node server/scripts/camelBus.js yaml [--out camel/family-bank.camel.yaml]
 *   node server/scripts/camelBus.js drive [--route family-bank-ingress] [--limit 50]
 *   node server/scripts/camelBus.js run [--interval 60]
 *   node server/scripts/camelBus.js exchanges [--route id] [--state pending] [--payment id]
 *   node server/scripts/camelBus.js show <exchangeId>
 *   node server/scripts/camelBus.js dead-letters
 *   node server/scripts/camelBus.js retry <exchangeId>
 *   node server/scripts/camelBus.js openach-status
 *   node server/scripts/camelBus.js openach-drive [--limit 25]
 *   node server/scripts/camelBus.js prune [--days 30]
 *
 * Every command is safe to re-run: routes consume idempotently on the message
 * key, so driving the bus twice mediates the same exchange once.
 */

const fs = require('fs');
const path = require('path');
const { CamelRouteEngine } = require('../integrations/camel/camelRouteEngine');
const { OpenAchRailEngine } = require('../integrations/openach/openachRailEngine');
const { installFamilyBankFlow } = require('../integrations/camel/familyBankFlow');
const { renderCamelYaml } = require('../integrations/camel/camelYaml');

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] || null;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  installFamilyBankFlow();

  switch (command) {
    case 'status': {
      await CamelRouteEngine.ensureTables();
      print('Camel integration context', await CamelRouteEngine.status());
      return;
    }

    case 'routes': {
      print('Registered routes', CamelRouteEngine.routes());
      return;
    }

    case 'yaml': {
      const yaml = renderCamelYaml({});
      const out = flag(args, 'out');
      if (!out) { console.log(yaml); return; }
      const target = path.resolve(process.cwd(), out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, yaml);
      console.log(`Wrote ${target}`);
      return;
    }

    case 'drive': {
      await CamelRouteEngine.ensureTables();
      print('Drive report', await CamelRouteEngine.drive({
        routeId: flag(args, 'route'),
        limit: flag(args, 'limit'),
      }));
      return;
    }

    /**
     * Run the bus in the foreground. Used when the server's own scheduler is off
     * (CAMEL_BUS_ENABLED=false) and this process is the bus of record.
     */
    case 'run': {
      await CamelRouteEngine.ensureTables();
      const interval = Math.max(Number(flag(args, 'interval')) || 60, 5);
      console.log(`[camel] driving every ${interval}s; Ctrl-C to stop`);
      const tick = async () => {
        try {
          const report = await CamelRouteEngine.drive({});
          if (report.claimed) print(`Cycle at ${report.startedAt}`, report);
        } catch (err) {
          console.warn('[camel] cycle failed:', err.message);
        }
      };
      await tick();
      const timer = setInterval(tick, interval * 1000);
      process.on('SIGINT', () => { clearInterval(timer); console.log('\n[camel] stopped'); process.exit(0); });
      return;
    }

    case 'exchanges': {
      print('Exchanges', await CamelRouteEngine.list({
        routeId: flag(args, 'route'),
        state: flag(args, 'state'),
        paymentId: flag(args, 'payment'),
        limit: flag(args, 'limit') || 50,
      }));
      return;
    }

    case 'show': {
      const id = args[0];
      if (!id) throw new Error('an exchange id is required');
      const exchange = await CamelRouteEngine.get(id);
      if (!exchange) throw new Error(`no exchange ${id}`);
      print(`Exchange ${id}`, exchange);
      return;
    }

    case 'dead-letters': {
      print('Dead letters', await CamelRouteEngine.deadLetters({ limit: flag(args, 'limit') || 50 }));
      return;
    }

    case 'retry': {
      const id = args[0];
      if (!id) throw new Error('an exchange id is required');
      print(`Replayed ${id}`, await CamelRouteEngine.retryDeadLetter(id, {
        actor: `cli:${process.env.USER || 'operator'}`,
      }));
      return;
    }

    case 'openach-status': {
      await OpenAchRailEngine.ensureTables();
      print('OpenACH rail', await OpenAchRailEngine.status());
      return;
    }

    case 'openach-drive': {
      await OpenAchRailEngine.ensureTables();
      print('OpenACH cycle', await OpenAchRailEngine.driveOnce({
        actor: `cli:${process.env.USER || 'operator'}`,
        limit: flag(args, 'limit'),
      }));
      return;
    }

    case 'prune': {
      print('Pruned', await CamelRouteEngine.prune({ days: flag(args, 'days') }));
      return;
    }

    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 29).join('\n').replace(/^ \* ?/gm, ''));
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
