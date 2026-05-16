export default {
  async fetch(request, env, ctx) {
    return new Response("Worker temporarily paused for maintenance.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  },
};
