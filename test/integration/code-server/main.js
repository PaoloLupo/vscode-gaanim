const fs = require("node:fs");
exports.activate = async () => {
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); log(...args); };
  try {
    await require(process.env.GAANIM_TEST_SUITE).run();
    lines.push("RESULT ok");
  } catch (error) {
    lines.push("RESULT fail " + (error && error.stack || error));
  }
  fs.writeFileSync(process.env.GAANIM_TEST_RESULTS, lines.join("\n") + "\n");
};
