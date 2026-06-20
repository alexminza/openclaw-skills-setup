const METHOD_NAME = "skills.setup";

type GatewayRequestHandlerOptions = {
  params?: Record<string, unknown>;
  respond: (ok: boolean, result: unknown, error?: unknown) => void;
  context: {
    getRuntimeConfig: () => unknown;
  };
};

type GatewayRequestHandler = (
  options: GatewayRequestHandlerOptions,
) => Promise<void> | void;

type PluginApi = {
  registerGatewayMethod: (
    method: string,
    handler: GatewayRequestHandler,
    options: { scope: string },
  ) => void;
};

export default {
  id: "skills-setup",
  name: "Skills Setup",
  description: "Runs installed skill setup scripts through the admin-only skills.setup gateway RPC.",
  register(api: PluginApi) {
    api.registerGatewayMethod(
      METHOD_NAME,
      async (options) => {
        const { handleSkillsSetup } = await import("./skills-setup.impl.js");
        await handleSkillsSetup({ api, options });
      },
      { scope: "operator.admin" },
    );
  },
};
