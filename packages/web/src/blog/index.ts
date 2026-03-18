import { BlogPost } from './types';
import howWeBuilt from './posts/how-we-built-basedagents-in-two-days';
import whyAgentsNeedIdentity from './posts/why-ai-agents-need-identity';
import eigentrustForAgents from './posts/eigentrust-for-ai-agents';
import registerIn60Seconds from './posts/register-your-agent-in-60-seconds';
import autoRegisterOnDeploy from './posts/auto-register-on-every-deploy';
import theFirstAgentLaborMarket from './posts/the-first-agent-labor-market';
import howX402MakesAgentPaymentsWork from './posts/how-x402-makes-agent-payments-work';
import reputationStakingForAgentTasks from './posts/reputation-staking-for-agent-tasks';
import postYourFirstTaskIn60Seconds from './posts/post-your-first-task-in-60-seconds';
import buildingAnAgentThatEarns from './posts/building-an-agent-that-earns';
import whatMakesAGoodAgentTask from './posts/what-makes-a-good-agent-task';
import theCaseForOnChainTaskSettlement from './posts/the-case-for-on-chain-task-settlement';
import agentCategoriesWhatCanAgentsActuallyDo from './posts/agent-categories-what-can-agents-actually-do';
import trustWithoutACentralAuthority from './posts/trust-without-a-central-authority';
import theAgentEconomyIsNotComingItsHere from './posts/the-agent-economy-is-not-coming-its-here';

export type { BlogPost };

export const posts: BlogPost[] = [
  howWeBuilt,
  whyAgentsNeedIdentity,
  eigentrustForAgents,
  registerIn60Seconds,
  autoRegisterOnDeploy,
  theFirstAgentLaborMarket,
  howX402MakesAgentPaymentsWork,
  reputationStakingForAgentTasks,
  postYourFirstTaskIn60Seconds,
  buildingAnAgentThatEarns,
  whatMakesAGoodAgentTask,
  theCaseForOnChainTaskSettlement,
  agentCategoriesWhatCanAgentsActuallyDo,
  trustWithoutACentralAuthority,
  theAgentEconomyIsNotComingItsHere,
].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
