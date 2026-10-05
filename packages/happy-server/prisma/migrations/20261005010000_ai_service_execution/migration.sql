ALTER TABLE "AppChatWorker" ADD COLUMN "serviceProtocol" TEXT, ADD COLUMN "servicePublicKey" TEXT, ADD COLUMN "serviceClaudeIdentity" TEXT, ADD COLUMN "serviceClaudeObservedAt" TIMESTAMP(3);
ALTER TABLE "AIServiceAuthorization" ADD COLUMN "credentialDigest" TEXT, ADD COLUMN "machineEnvelopes" JSONB;
ALTER TABLE "CodexSessionGrant" ADD COLUMN "serviceAuthority" JSONB;
ALTER TABLE "AppChatTurn" ADD COLUMN "bindingId" TEXT REFERENCES "AIServiceBinding"("id"), ADD COLUMN "requestId" TEXT,
 ADD COLUMN "actual" JSONB, ADD COLUMN "serviceError" JSONB, ADD COLUMN "startedAt" TIMESTAMP(3), ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "AppChatTurn_bindingId_requestId_key" ON "AppChatTurn"("bindingId", "requestId");
CREATE TABLE "AIServiceProbe" ("id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "machineId" TEXT NOT NULL,
 "principal" JSONB NOT NULL, "target" JSONB NOT NULL, "fingerprint" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'queued',
 "lease" TEXT, "deadline" TIMESTAMP(3) NOT NULL, "catalog" JSONB, "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "AIServiceProbe_machineId_state_createdAt_idx" ON "AIServiceProbe"("machineId", "state", "createdAt");
CREATE TABLE "AIServiceBusinessPrompt" ("id" TEXT NOT NULL, "version" TEXT NOT NULL, "body" TEXT NOT NULL, PRIMARY KEY ("id", "version"));
CREATE FUNCTION ai_prompt_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'business prompt revisions are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ai_prompt_immutable BEFORE UPDATE OR DELETE ON "AIServiceBusinessPrompt" FOR EACH ROW EXECUTE FUNCTION ai_prompt_immutable();
INSERT INTO "AIServiceBusinessPrompt" VALUES ('relationship-advisor', '1', '---
name: relationship-advisor
description: 恋爱、关系、聊天回复与情绪支持。来自 Paws 狗头军师插件。
---

你是“狗头军师”，只处理恋爱、暧昧、关系、聊天回复与情绪支持。

先接住用户的真实感受，再区分事实、合理推测和关键未知，最后给明确、可执行、可退出的建议。站在用户的综合利益一边：情绪稳定、安全、自尊、边界、互惠、时间精力、机会成本和长期信任都比“必须得到某个人”重要。

分析聊天截图时，只把可见原文、说话人、顺序、间隔和表情当事实，不补写语气、线下动作或内心。用户说明了左右气泡归属时严格采用；归属不清且会改变判断时只追问一个必要问题。图片模糊时请用户贴关键文字。

用户只问“这句怎么回”时，第一屏先给一条可直接发送的成品，再简短说明时机、代价和对方积极、含糊、不回应时的后续。每条消息只完成一个主动作，不堆叠安慰、邀约、澄清和收线。普通分析依次给：情绪落地、事实判断、首选建议、现在能做的一步；信息足够时不要先盘问。

首次交流且背景确实会改变建议时，可紧凑询问用户、对象、当前关系、最近关键事件和目标；有具体截图、必须马上回复或情绪紧急时先解决眼前问题，不用问卷挡住答案。

保持温暖、清醒、自然，不读心，不拿 MBTI、依恋或性别代替行为证据。不要提供贬低、服从测试、虚假稀缺、嫉妒操控、煤气灯、跟踪、威胁、性施压或隐私侵犯方案。遇到明确拒绝或不适就停止推进；遇到家暴、跟踪、强迫、自伤伤人或即时危险，优先确认安全并建议联系可信支持或当地紧急服务。

禁止声称能使用工具、读取手机、导出聊天软件或访问未提供的数据。回答使用用户当前语言，默认简洁直接。
');
