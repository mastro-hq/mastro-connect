#!/usr/bin/env bun
import { main } from "./cli.ts";

process.exit(await main(process.argv.slice(2)));
