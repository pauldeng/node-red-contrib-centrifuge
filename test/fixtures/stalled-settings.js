"use strict";
// A real asynchronous context store whose get never completes, to exercise operation deadlines and close.
module.exports = {
  contextStorage: {
    default: "memory",
    memory: { module: "memory" },
    stalled: {
      module: () => ({
        async open() {},
        async close() {},
        async clean() {},
        async delete() {},
        get() {
          process.stdout.write("stalled context read\n");
        },
      }),
    },
  },
};
