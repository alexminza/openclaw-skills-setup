import type { SkillsSetupApi, SkillsSetupHandlerOptions } from "./skills-setup.impl.js";

const METHOD_NAME = "skills.setup";

type GatewayRequestHandler = (
  options: SkillsSetupHandlerOptions,
) => Promise<void> | void;

type PluginApi = {
  registerGatewayMethod: (
    method: string,
    handler: GatewayRequestHandler,
    options: { scope: string },
  ) => void;
} & SkillsSetupApi;

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
