import { BlogPost } from './types';
import howWeBuilt from './posts/how-we-built-basedagents-in-two-days';
import whyAgentsNeedIdentity from './posts/why-ai-agents-need-identity';
import eigentrustForAgents from './posts/eigentrust-for-ai-agents';
import registerIn60Seconds from './posts/register-your-agent-in-60-seconds';
import autoRegisterOnDeploy from './posts/auto-register-on-every-deploy';

export type { BlogPost };

export const posts: BlogPost[] = [
  howWeBuilt,
  whyAgentsNeedIdentity,
  eigentrustForAgents,
  registerIn60Seconds,
  autoRegisterOnDeploy,
].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
