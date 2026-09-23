#!/bin/bash
# Runs every meeting of the honest protocol in parallel, one process each. Usage: run-all.sh <run-dir> [meetings...]
# The robot's briefing is read from a snapshot of bin/attend.mjs taken here, so the run measures what it started with.
# MAX_PARALLEL (default 4) caps meetings at once: at 11-12 in parallel (about 24 voice sessions plus judges) the robot's
# answers slipped a turn late on 2026-09-23 while one session alone answered in 2.5-4.5 s, which corrupts every timing
# grade. Fewer at once takes longer and measures what a real meeting would get.
cd "$(dirname "$0")/../.."
R=$1; shift; M=${@:-1 2 3 4 5 6 7 8 9 10 11}
mkdir -p $R
cp bin/attend.mjs $R/attend.snapshot.mjs
export HONEST_ATTEND_SRC=$PWD/$R/attend.snapshot.mjs
MAXP=${MAX_PARALLEL:-4}
for n in $M; do
  while [ $(jobs -rp | wc -l) -ge $MAXP ]; do sleep 5; done
  node tools/sim-participant/honest-loop.mjs tools/sim-participant/protocol/protocol.json --pdf-text tools/sim-participant/protocol/pdf-text.txt --out $R --chapters $n > $R/log-$n.txt 2>&1 &
  sleep 15
done
wait
echo ALL DONE
grep -h "honest protocol" $R/log-*.txt
