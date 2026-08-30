# 协议设计与演进

## Schema 是运行时合同

每个外部 payload 先定义 Zod schema，再由 z.infer 导出 TypeScript 类型。schema 与类型同名配对，消费者从包根导入。不要只新增 interface；那不会保护运行时。

    export const UpdateThingBodySchema = z.object({
      t: z.literal('update-thing'),
      id: z.string(),
    });
    export type UpdateThingBody = z.infer<typeof UpdateThingBodySchema>;

联合类型使用稳定 discriminator，例如 messages.ts 的 role 和 update body 的 t。新增 union 成员必须考虑未知旧客户端如何处理，并给正例、缺字段、错误 discriminator 和边界值测试。

## 兼容边界

legacyProtocol.ts 是明确的旧格式读取边界；新功能不应继续扩大 legacy 类型。messages.ts 中 ApiMessageSchema 等 alias 服务现有消费者，删除或重命名前必须迁移全部 workspace consumer 并评估外部 npm 用户。

sessionProtocol.ts 顶部明确标记为 UNDER REVIEW 和 frozen：当前 producer/consumer 依赖它，但不要增加新消费者或继续扩展 event union，除非任务先确认协议方向。

createEnvelope 必须通过 sessionEnvelopeSchema.parse 自校验，不能构造绕过 role/event 约束的对象。service、start、stop 等 agent-only 规则继续放 superRefine 并有拒绝用例。

## 变更检查面

协议修改同时检查：

- packages/happy-cli 的 mapper 与 api/types.ts
- packages/happy-agent 的 RawMessage/API
- packages/happy-app 的 sync/apiTypes.ts、typesRaw.ts、reducer
- packages/happy-server 的 Prisma JSON typing 与 EventRouter
- docs/happy-wire.md 和相关协议文档是否仍描述当前合同

## 控制文本

controlMessages.ts 对 task-notification 只剥离完整、位于开头且嵌套平衡的 wrapper。未闭合或正文中用户示例必须原样保留。文本协议解析不能用贪婪正则吞掉真实消息。

## 反例

- export type 后没有对应运行时 schema。
- 在 consumer 本地复制一份略有差异的 Zod object。
- 给已有必填字段改语义但不改版本/兼容处理。
- 为一个 provider 的临时事件扩展冻结的 sessionEventSchema。
