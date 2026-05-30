# 一个 AI 还是不够

今天我们介绍 MiniMax Agent 的整体升级，我们将升级后的 Agent 起了个新名字：Mavis — MiniMax as a Jarvis。

这次进行了以下更新：

- **上线 Agent Teams。**MiniMax Agent 桌面端现在支持多个 Agent 并行工作，你可以创建不同角色的 Agent，让它们组成一个团队协作完成任务，适合那些又长又复杂、一个 Agent 搞不定的任务。
- **TokenPlan 和 Agent Plan 合并。**一份订阅，CLI、API、Agent 全打通，M2.7、音乐、视频、语音所有模型都包含在内。Credits 额度在 Agent 和 API 之间可以共享，用法更灵活。如果你之前同时订阅了两个 Plan，会额外赠送一个月会员。

下载链接：agent.minimaxi.com/download

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/63e1da1189204013840780ac918e8174?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_69c863dc9819b39378c7959d953d69041779869478350\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=b978f45a3568dfc7a507455aa4536f4a2d6df3df\&q-url-param-list=)

此次，我们想跟大家分享我们做 Agent Teams 背后的思考：我们是怎么设计 Agent team 的？是为了解决什么问题？我们付出了什么成本？用户该什么时候该用 Agent Team、什么时候没必要用？

**为了把这些讲清楚，我们用 Agent Team 做了个实验，用一个 Agent 模拟用户提问，一个 Agent 基于我们的技术 Blog 回答，生成了一份文字访谈。**

**痛点与本质：**

**为什么要做 Agent Team**

**Q：最好奇的问题是，你们为什么要做 Agent Team，单 Agent 不够用吗？**

A：我们内部跑了 Agent 产品一段时间，发现单 Agent 在复杂任务上主要有四个痛点。

第一个是**它会在你意想不到的时候停下来**。比如用户给了 7 件事，它做完 3 个就停了，就开始汇报了，“我已经完成了 1、2、3，要不要继续做剩下的”。这其实是因为模型普遍存在上下文焦虑，模型本身对于「超长任务什么时候该停」的判断就是模糊的。

第二个是**长任务越跑越笨**。用户的体感是，一开始它像个聪明助手，跑着跑着变成了一个容易分心的人。你得不断追问：刚才那条要求还记得吗？那个来源核实过了吗？写着写着风格怎么变了？只要其中一个环节走偏，后面的内容就会沿着偏差继续生成。而且单 Agent 很难形成自我制衡，它可能很真诚地自检，但检查的仍然是自己刚刚构造出来的东西。

第三个是**长任务期间没法快速响应用户**。特别是在 IM 场景下，用户发一条消息往往是期待几秒内有回应的，哪怕任务很复杂，也希望对方先“收到了，我会怎么做”。但单 Agent 要么给一个很浅的答案，要么让用户盯着对话框等十分钟甚至更久。我们收到了大量的用户反馈说，“我的 Agent 怎么不回我了”

第四个是**角色分工的问题**。一个用户同一天可能要写代码、查资料、做 PPT、整理会议纪要、处理表格。每类任务的工具权限、质量标准、交付格式都不同。单 Agent 可以通过 Skill 暂时扮演不同角色，但角色扮演不等于角色分工，真正的分工至少包括工具不同、上下文不同、记忆不同、Skill 不同，输出协议和验收标准也不同。

这四个问题加在一起，就是我们做 Agent Team 的出发点：**一个 Agent 同时当裁判又当选手就会产生问题，这是靠单体迭代很难解决的。**

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/70aa20080e484f34acafac59a4b61278?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_b3ba0727f06b3cbb99749751f34875151779869477746\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=1228360f2b62aebd2989f66ecfaed67a5e858f5e\&q-url-param-list=)

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/badd475d15c243f3b805a07cab3902db?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_db5bf7f06fb25e12bbca1a28d3f6fc8a1779869477754\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=2bc83342c03dda847ee7cd37748c0e07125ea766\&q-url-param-list=)

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/9b3feeea5dc34dab92a081672d4b137a?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_f2b592e8be72f1561f089fbcfad798ae1779869477757\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=c2c75d4aa9a2de6a0a990309a5d90ffe5fb00d27\&q-url-param-list=)

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/0d7162edf39044dc91d406ca122c775d?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_7e3215adc61875fa2cffc2f15ac363d91779869477714\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124005%3B1780152805\&q-sign-algorithm=sha1\&q-sign-time=1780124005%3B1780152805\&q-signature=6fb412d46a13ddef73f6810f4d9abfa139727fe0\&q-url-param-list=)

单 Agent 局限性与 Agent Team 分工模式

（上下滑动浏览图示）

Q：你们**做下来，觉得 Agent Team 在技术本质上到底是什么？我见过很多所谓的多 agent 方案，其实就是几段 Prompt/Skill 让模型扮演不同角色，你们的有什么不同？**

**A：** 这可能是我们做这件事最重要的一个认知：**多 Agent 系统不是 Prompt/Skill 编排，而是一套需要持续运行和维护的基础设施。**

多 Agent 经常被简化成，“写几段 prompt 扮演不同角色”，但是这种做法，在真实业务里效果并不稳定。你可以这样理解，Prompt/Skill 编排就像写了一份工作手册发给几个人，每个人按手册做事；**但真实的团队协作还需要一整套支撑系统（Harness）：谁负责分配任务、任务做到哪一步了、卡住或失败了怎么办、做完了谁来验收。**这些事情Prompt/Skill 只能做软约束，难以形成稳定运行、可靠的持续交付，必须有一套活的系统在背后运转。我们的 Team Engine 就是这套系统，Prompt/Skill 只是其中很薄的一层。

**同时，实际的复杂度都藏在细节里。**比如同样是“创建一个任务”这个动作，发起方可能是用户、可能是另一个 Agent、也可能是 Team Engine 、/loop的任务循环，形式类似、路径和目的不同、但最终效果统一；过程中的大量U2A、A2A消息通信，需要在UI、Agent Context中为用户与 Agent 合理地组织，还有 Agent 之间的对话、定时任务的消息、来自 IM 的用户消息——这些都要在界面上给用户合理地组织和呈现。其背后大量的思考和实现细节，都是为了让用户体验到“只要对话，Agent Team就会帮我完成一切，越用越聪明、越来越懂我”。

行业中的实践也在往这个方向走。最近发布的许多 Agent 框架，他们的核心关注点也都不是怎么写更好的 prompt，而是任务管理、状态恢复、权限控制、过程追溯这种基础设施能力。**Agent 产品的重心正在从写 prompt 转向维护这套基础设施。**

**Q：现在做多 Agent 的框架和产品不少，OpenAI 有 Agents SDK，Google 有 ADK，Claude Code 也有 Teams 机制，你们跟这些方案的核心区别在哪？**

A：这个问题很好。行业里做多 Agent 的方案确实越来越多，但大多数的基本思路是相似的：有一个主 Agent 负责调度，其他 Agent 负责执行，执行完了把结果返回来。区别主要在调度方式上，有的是把控制权移交给下一个 Agent，有的是把其他 Agent 当工具来调用，有的是通过消息收发来协作。

这些方案各有特点，但我们觉得有几个地方 MiniMax 的 Agent Team 做得不太一样。

第一是**对抗性的质量门禁**。我们的 Worker 和 Verifier 之间是对抗关系，类似企业里研发和质量部门的关系，通过多轮对抗式迭代来保证交付质量，而不是靠 Agent 自己说“我做完了”。很多框架里的验证环节是可选的附加步骤，在我们这里它是架构的核心。

第二是**确定性的代码逻辑驱动**。我们用状态机来管理 Agent 的运行周期，而不是依赖模型的自由判断来决定接下来该干什么。什么时候该验证、什么时候该重试、什么时候该停止，都是引擎层面的硬性约束。

第三是**上下文隔离**。我们受到了 Harness 思想的启发，意识到大模型的上下文是宝贵的资源。通过拆分任务和职责分类，让每个环节的上下文相互隔离，而不是所有 Agent 共享一个不断膨胀的对话历史。

**Q：那你们的 Agent Team 具体是怎么设计的？不是说把任务拆给几个 Agent 就叫 Team 吧，你们的架构是什么样的？**

**A：** 对，光拆任务不叫 Team。我们的设计是一个**主 Agent 牵头的任务团队**，团队里有三类核心角色：Leader、Worker、Verifier。

**Leader 是整个 Team 的控制面**，负责理解用户目标、拆分子任务、决定执行顺序、分配每个任务由哪个 Worker 来接、合并结果、控制什么时候停止。你可以理解为项目经理。

**Worker 负责具体执行**。不同 Worker 可以拥有不同的工具、上下文和输出要求。有的做资料检索，有的写代码，有的生成文档，有的处理表格，有的调用外部系统。Worker 的价值在于专业化，角色越清楚，它的输出就越容易被复用、比较和检查。

**Verifier 负责把「完成」变成「可以交付」**。它可以检查事实来源、跑代码测试、核对格式要求、对照覆盖清单，也可以对 Worker 的结果提出修改意见。这里有一个关键的设计逻辑：Worker 停止的条件是 Verifier 启动的原因，Verifier 停止的条件是尽可能发现 Worker 的问题，而发现的问题又成为 Worker 重新启动的原因。它们之间是相互制衡的关系。

必要的时候，人类会和 Leader 一起做决策，特别是高风险变更、模糊需求、或者成本继续扩张的时候。

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/7883b9eb9a1d49a285e792546d8a353c?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_02e3fb21cd6540a5ff30a8c94ab6e6291779869477889\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124005%3B1780152805\&q-sign-algorithm=sha1\&q-sign-time=1780124005%3B1780152805\&q-signature=38552f24756763c997317ddfff113ac2351287ac\&q-url-param-list=)

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/1b5eff2b1c02413f9f18e91318231ffb?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_92a395c0da6dba5ba910320b809f85c61779869478024\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=fbd39fa78721b345e0bbd51f5efd89b540e9c622\&q-url-param-list=)

**Q：这个 Leader-Worker-Verifier 的分工听起来很清晰，但我有一个疑问，现在很多 Agent 框架已经支持主 Agent 把一个子任务派给另一个 Agent 去做，传个指令进去，拿到结果回来，这不也是一种拆分吗？你们的 Agent Team 和这种做法有什么本质区别？**

**A：** 你说的这种机制确实很常见，一般叫 Task 派发，主 Agent 调用一个工具，把一段指令发给子 Agent，子 Agent 跑完把结果返回来，交互就结束了。适合快速搜个文件、归纳一段材料、生成候选答案这种短任务。

但问题是，这种派发本质上是一次收发。任务发出去之后，中间发生了什么主 Agent 不知道，子 Agent 卡住了没法喊人，主 Agent 想补充一句也没有通道。

我们的 Agent Team 是一个可以持续互动的团队。打个比方：Task 派发像发一封邮件等回复，Agent Team 像开了一个持续在线的工作群。Worker 做完了可以继续接新消息，做到一半卡住了会被发现，Leader 随时可以补充指令，Verifier 检查出问题可以直接打回去让 Worker 改。

为了让这种持续协作稳定运行，我们底层做了一套引擎来管理每个 Agent 当前处在什么阶段，在等待、在执行、在验证、还是已完成。同一个 Agent 重试的时候还能复用之前的上下文，不用从头来过。所以协作关系不再是一次函数调用，而是跨时间的消息交换和状态推进。

**Q：你刚才提到 Agent 之间可以互相通讯，这个通讯机制是怎么实现的？Agent 之间怎么知道该跟谁说话、能做什么操作？**

**A：** 我们设计这个的时候，出发点很直接：先看人和 Agent 是怎么协作的。用户在前端可以给 Agent 发指令、启动一个新 Agent、中止一个任务、让 Agent 总结进展——这些操作用户天天在做。我们的想法是，**Agent 自己也应该有能力对另一个 Agent 做同样的事**。

![](https://ima-notebook-prod.image.myqcloud.com/2/d7xZEeYFcZYMNdf68fofxe/34a0517dd23e418cac41dbac228672c2?media_id=img_6707e79f5915f40e44b0f9df70c96a7f_6828c45d4104ca9cf4c9bc12bd035e6c1779869478359\&q-ak=AKID9IDtLZZKqGRO7hVFnMn0zjXTXovoTtAN\&q-header-list=\&q-key-time=1780124004%3B1780152804\&q-sign-algorithm=sha1\&q-sign-time=1780124004%3B1780152804\&q-signature=856e852f95e459aabd559df19ece292c9a067b2c\&q-url-param-list=)

所以我们把用户对 Agent 的这些操作抽象成了一套统一的接口。这样一来，真正操作一个 Agent 的可以是用户，可以是另一个 Agent，也可以是 Team 引擎本身——走的是同一套协议。

当然，这种设计必须有边界。Agent 之间能互相调度，不意味着每个 Agent 有无限权限，更不意味着人类退出了责任链。恰恰相反，因为 Agent 和人类走的是同一套操作接口，谁做了什么、有没有越权，反而更容易被审计和追溯。

**四个核心落地场景**

**Q：架构讲清楚了，我想听具体场景，你们实际在哪些场景下跑 Agent Team，效果怎么样？你们最先在哪些场景里场景了。**

**A：** 最先落地的是**通讯软件里的 Agent，**比如用户在微信、飞书这类 IM 里给 Agent 发消息。

这个场景的矛盾是很尖锐的，用户发一条消息，就是期待几秒内有回应，但很多任务天然需要几分钟甚至更久，比如查资料、整理会议纪要、做 PPT、跑测试，任务本身就是需要时间的。单 Agent 在这里就陷入两难：要么为了快速回复给一个浅答案，要么为了把事做完让用户长时间没反馈。而且 IM 里对话是不停的，用户可能中途追加需求、切换话题，长任务和新消息挤在同一个上下文里，就会互相污染。我们曾经收到了大量的用户反馈是“我的 Agent 怎么不回我了”

**Q：所以 Agent Team 怎么解这个问题？**

**A：** 核心思路是**把「秒回用户」和「执行任务」拆成两件事**。

主 Agent 收到消息后先快速响应：收到了，目标确认，我会怎么做。然后把具体任务拆到后台，分配给不同的 Worker 并行执行。用户不用盯着对话框等，关键节点会收到汇报，比如任务开始了、遇到卡点了、需要你做决定、已经完成了。

而且因为主 Agent 自己没有被后台任务占住，用户随时可以继续聊。比如说“我刚想到一个新方向，你顺便帮我查一下”，主 Agent 可以马上回：“好的，我再派一组 Agent 去查，有进展随时跟你说。顺便汇报一下，之前的任务已经完成了 2/5，剩下的有 2 个在核查，还有 1 个在跑。”

体验上就像一个能秒回你微信、同时后台还在帮你干活的同事。

**Q：这个 IM 场景确实是刚需。你们在 Coding 方面呢？代码任务应该是 Agent Team 比较天然适配的场景吧？**

**A：** 对，Coding 是我们的第二个核心场景，而且我们的 Agent Team 项目很大程度上受到了 Harness 思想的启发。Harness 强调的是在写代码的基础上更进一步：Agent 不仅要写代码，还要跟进开发全流程，代码要有分支，执行要有沙箱，修改要有 diff，测试要能重跑，审查要有记录，失败要能回放，必要时还要能把任务拆给不同角色。**让 Agent 运行的停止条件绑定到有确定性、可观测的外部系统。**

在 Coding 场景下，我们的 Team 至少有四类角色。**Leader** 先判断任务是否值得启动 Team，比如改错别字、替换常量，单 Agent 或脚本更便宜；跨文件理解、测试补齐、风险审查、多方案取舍，才适合 Team。它还要决定拆解粒度：是否先读代码、是否并行探索方案、是否先写复现测试、失败后重试几次、什么时候升级给人类。

**Developer** 负责实现，它的输出不只是自然语言说明，还包括 diff、修改理由、潜在风险和验证建议。**Tester** 负责找现有测试入口来验证结果。**Reviewer** 来检查抽象边界、兼容性、错误处理、依赖引入、权限扩大、日志是否暴露敏感信息、是否绕过项目规则。

**Q：那研究类任务呢？比如让 Agent 帮我做行业调研、查资料写报告，这种场景下 Agent Team 比单 Agent 好在哪？**

**A：** 单 Agent 做研究有几个很难靠自身克服的问题。

首先是**速度**，一个 Agent 串行地搜索、阅读、整理，碰到需要查十几个来源的任务就很慢。其次是**视角单一，**一个 Agent 形成了初步判断之后，后续的搜索和整理会不自觉地围绕这个判断展开，调研方向容易有偏。第三是**证据链管理**，查过的资料越多，哪条结论来自哪个来源、那个来源是否可靠，在一个不断膨胀的上下文里越来越难追溯。最后还有一个容易被忽视的问题：Agent 在搜索过程中接触到的网页内容可能包含恶意注入，单 Agent 的上下文很容易被污染。

Agent Team 的做法是**把研究过程拆成多条并行的信息通道**。不同的 Worker 从不同角度、甚至正反面去搜集信息，最终由专门的角色来合并成结构化的结论。

<br />

**Q：你们之前一直在强调 Verifier，在研究场景里它具体做什么？**

**A：** 在研究场景里，Verifier 的核心任务是**确保结论站得住脚**。

具体来说它做两件事。第一是检查**来源是否可复查，**引用的是不是一个别人也能打开、也能验证的稳定链接？官方页面、论文、GitHub 仓库这些算；但如果只是搜索引擎的缓存页、某个打不开的社区帖、或者一个聚合站的二手转述，那只能当线索，不能作为正式结论的支撑。

第二是检查**信息是否过时**——一个来源上周访问不了但这周恢复了，报告里不能还留着“无法确认”的标注；一个页面的发布日期没核实过，就不能在报告里写成确定时间。

这两件事听起来会很简单，但靠单 Agent 自检很难做到。因为搜索、整理和验证是同一个 Agent 在同一个上下文里完成的，它很难跳出来用独立视角审视自己刚刚得出的结论。**独立 Verifier 的价值就在于，它和做研究的 Worker 不共享同一个上下文，没有“我刚查过所以应该没错”的惯性。**

**Q：你们还提到了办公文档的场景？这个我特别想听，做 PPT、写报告这些，单 Agent 不是已经能做了吗？**

**A：** 能做和能交付是两件事。单 Agent 做文档最容易出现的错觉就是：只要模型会写，就等于能交付。

短文档还行，一旦任务变成长报告、正式合同、财务表格、项目复盘 PPT，就会有问题，因为太多信息比如内容规划、资料引用、结构一致性、版式规范、文件格式、表格公式、图表对象、页眉页脚、目录、导出质量等等，都会挤在同一个上下文和同一个执行循环里。

Agent Team 的做法是把文档交付拆成多个可验证阶段。**Planner** 先定义文档目标和结构；**Writer** 负责正文；**Formatter** 负责版式和文件对象；**Tool Agent** 调用具体的文档工具；**Evaluator** 独立检查内容、格式和文件完整性。

这样拆分之后，文档生成就从一次性文本生成，变成了构建流水线：每一步产出都有中间件，每一步都有检查，每一步失败都能局部重试。

**成本、验证与决策判断**

**Q：场景我都听明白了，确实有价值。但我必须问一个现实问题，多 Agent 协作的成本怎么样？直觉上，Agent 越多，token 消耗越大，交互越复杂，这个账算得过来吗？**

**A：** 这个问题我们内部也花了很多时间想。我们确实需要承认，多 Agent 不是天然更划算的。有一篇论文叫 Cost of Consensus，在特定模型和同质 debate 设置下发现，多 Agent 的 token 消耗可能达到单 Agent 自我修正的 2.1 到 3.4 倍，准确率却没有提升甚至更差。虽然我们认为这个结论不能外推为，所有多 Agent 是浪费的，但它还是指出了一个事实是：**没有结构、没有验证、没有停止条件的多 Agent 是不成立的。**

但从另一个角度来讲，用户的成本也不只是 token。单 Agent 任务里，用户也有等待的成本，但多 Agent 的任务结构就会让复杂任务更透明，多 Agent 的价值和成本是一起出现的，关键在于有没有一个结构让这个成本值得。

**Q：那具体到你们的实现里，成本主要贵在哪几个地方？**

**A：**我们梳理下来，多 Agent 协作会暴露三类单 Agent 不会遇到的成本。

第一是**交接成本**。信息在 Agent 之间传递时需要重新组织。研究 Agent 收回来几十个网页，写作 Agent 可能是用不了的，每一次交接都要把信息从“上一个 Agent 能懂”翻译成“下一个 Agent 能用”。我们的做法是让 Agent 之间通过结构化的文件和摘要来通信，而不是把所有上下文塞进一个 prompt 里。

第二是**共享成本**。直觉上觉得让所有 Agent 看到所有信息最安全，但每多共享一段内容，每个 Agent 每一轮都要为它付 token。我们的做法是按需加载，每个 Agent 只看到跟自己任务相关的信息摘要，需要细节的时候再去读全文。这样 Team 规模变大的时候，单个 Agent 的上下文不会被撑爆。

第三是**聚合成本**。派十个 Agent 并行查资料很容易，但把十份结果合成一份事实一致、引用准确、风格统一的交付物很难。这一步没有捷径，Leader 要花真实的精力去合并，不是“再多派几个 Agent”能解决的。确实要承认这件事本身就贵。

**Q：你们前面反复提到 Verifier，说它是从演示走向交付的关键。但 Verifier 本身也要消耗资源吧？验证越认真越贵，不验证又没意义，这个平衡怎么把握？**

**A：**对，Verifier 有三个成本。第一笔是**验证本身的消耗**。不管是跑代码测试、核对研究来源、还是检查文档格式，认真验证就是要花时间和 token。所以验证不能只是走个过场，那还不如不设 Verifier。

第二笔是**重试的成本**。Worker 改一点、被 Verifier 退回、再改一点、又被退回。那如果这个循环没有退出机制，整个任务会越跑越贵，对应的是需要有退出机制。

第三笔是**人类决策的成本**。有些动作风险太高，比如要不要合并代码这种是不能让 Agent 自己拍板的，必须有人类来签字。这意味着 Agent 交付的不只是一个结果，还要留下完整的过程记录，让人能看懂发生了什么、能判断、能接管。

**Q：所以总结一下，你们认为什么样的团队或场景值得上 Agent Team，什么时候其实不需要？**

**A：** Team 不是默认选项，是策略选项。任务越复杂、链路越长、风险越高、经验越可复用，越值得上 Team。任务越短、越低风险、越确定，单 Agent 甚至脚本就够了。

![](<data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8'%3F%3E%3Csvg width='1px' height='1px' viewBox='0 0 1 1' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3E%3Ctitle%3E%3C/title%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' fill-opacity='0'%3E%3Cg transform='translate(-249.000000, -126.000000)' fill='%23FFFFFF'%3E%3Crect x='249' y='126' width='1' height='1'%3E%3C/rect%3E%3C/g%3E%3C/g%3E%3C/svg%3E>)

