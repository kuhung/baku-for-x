import { handleFlywheelRequest } from './app.js';

export default {
  async fetch(request, env, ctx) {
    return handleFlywheelRequest(request, env, ctx);
  },
};
