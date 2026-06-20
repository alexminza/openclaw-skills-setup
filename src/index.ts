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
  description: "Runs trusted installed skill setup scripts through the admin-only skills.setup Gateway RPC.",
  register(api: PluginApi) {
    api.registerGatewayMethod(
      METHOD_NAME,
      async (options) => {
        api.logger.debug?.("skills.setup: ensuring implementation is loaded");
        const { handleSkillsSetup } = await import("./skills-setup.impl.js");
        await handleSkillsSetup({ api, options });
      },
      { scope: "operator.admin" },
    );
  },
};
