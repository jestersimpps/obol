function getDefinitions() {
  const { buildBridgeTool, buildBridgeTellTool } = require('../../bridge');
  return [buildBridgeTool(), buildBridgeTellTool()];
}

const handlers = {
  async bridge_ask(input, memory, context) {
    const { bridgeAsk } = require('../../bridge');
    return await bridgeAsk(input.question, context.userId, context.config, context._notifyFn, input.partner_id);
  },

  async bridge_tell(input, memory, context) {
    const { bridgeTell } = require('../../bridge');
    return await bridgeTell(input.message, context.userId, context.config, context._notifyFn, input.partner_id);
  },
};

const requiresBridge = true;

module.exports = { getDefinitions, handlers, requiresBridge };
