# 通用 2D 游戏框架系统路线图

> 目标：将当前框架从 17% 成熟度（8/50 系统）演进为通用 2D 游戏框架。
> 现状：8 个内置系统中 6 个完整、2 个占位（inventory / interaction）。
> Phase 0（切片前止血）已完成，修复了 5 个框架级缺陷，详见下文「已有系统状态」。

## 一、核心仿真
- Transform / Physics / Movement / Collision — 位置、速度积分、碰撞检测与分离
- Animation / Sprite — 帧动画状态机、精灵渲染数据
- Pathfinding（寻路） — A* 算法在网格上规划可绕障路径
- Steering（操控行为） — 分离、聚合、跟随、避让等群体移动

## 二、AI
- BehaviorTree（行为树） — 按优先级顺序选择动作分支
- UtilityAI（效用 AI） — 根据需求/环境评分动态选最优动作
- StateMachine（状态机） — 有限状态间切换驱动行为
- GOAP（目标导向动作规划） — 反推动作序列达成目标
- Perception / Sensor / Memory — 感知视野内实体、记忆历史事件

## 三、战斗
- Combat（伤害/射程/范围） — 攻击距离、扇形/圆形范围判定
- Health / Death — 生命值衰减与死亡清理
- Skill / Cooldown — 技能释放与冷却计时
- StatusEffect / Buff / Debuff — 持续性状态效果（中毒、加速等）
- Spawning（生成） — 按规则在区域内动态生成实体

## 四、生存
- Needs（需求） — 饥饿、口渴、体力、睡眠等持续衰减指标
- DayNightCycle（昼夜循环） — 时间推进与光照变化
- Weather（天气） — 雨/雪/雾，影响采集与生存
- Temperature（温度） — 体温/环境温度影响生存衰减

## 五、经济与物品
- Inventory / Equipment — 背包槽位管理与穿戴装备
- Crafting / Recipe（合成/配方） — 多材料组合产出新物品
- Loot / Drop — 击杀/采集掉落物
- Shop / Trade / Economy — 交易、商店、货币流通
- ResourceNode（采集点） — 可被采集并消耗的资源节点

## 六、社交与进度
- Relationship（N:N 关系图） — 实体间好感度/敌对度边权
- Dialogue（对话） — 分支对话树与选项
- Quest / Mission — 任务接取、进度、完成
- Faction / Reputation — 阵营归属与声望值
- Achievement（成就） — 解锁条件检测与记录
- Progression（等级/经验） — 经验积累与等级提升

## 七、建造与世界编辑
- Building / Placement — 玩家放置建筑/家具
- GridOccupancy（网格占用） — 标记格子是否被占用
- Interactable / Furniture — 可交互物体与家具属性
- Portal / Door（场景切换） — 区域/场景间传送

## 八、网络与服务端
- Sync（状态同步） — 服务端权威状态推送客户端
- InterestManagement（兴趣管理） — 视野裁剪，只同步附近实体
- LagCompensation / Reconciliation — 延迟补偿与客户端预测回滚
- Persistence / SaveLoad — 持久化到数据库与加载
- Matchmaking / Room — 匹配与房间管理
- AntiCheat / Validation — 输入合法性校验
- Telemetry / Metrics / Replay — 遥测、性能指标、回放

## 九、输入与控制
- InputMapping / Keybind — 按键映射到游戏动作
- CommandQueue / ActionQueue — 玩家指令排队依次执行
- Selection / GroupControl — 单选/框选/多单位控制
- Camera（相机） — 视角跟随、缩放、边界限制

## 十、元系统
- Audio — 音效/音乐播放与 3D 听觉
- Particle / VFX — 粒子特效数据
- UI / HUD — 界面元素与状态显示
- Localization / I18n — 多语言文本
- Settings / Options — 画质/音量/控制偏好
- Modding / Scripting — 玩家模组与脚本扩展
- DebugTools / Cheats — 调试快照、作弊指令

---

## 当前框架覆盖（约 8/50 ≈ 17%）

### ✅ 已有
- physics、movement、collision、ai(BT 绑定 action + condition)
- combat（射程判定已补齐）、spawning（按 kind/多边形过滤已补齐）
- inventory(占位)、interaction(占位)
- sync(仅 number)、logger

### ❌ 缺口最大三类
1. **AI 高级决策** — UtilityAI、StateMachine、GOAP、Perception
2. **网络服务端** — InterestMgmt、LagComp、Persistence、AntiCheat
3. **社交进度** — Relationship、Dialogue、Quest、Achievement、Progression

### 🔧 已有系统状态

> Phase 0（切片前止血）已完成 5 个框架级缺陷修复：combat 射程判定、spawning 按 kind/多边形过滤、inventory 满包吞物品、systemRegistry before 语义、btFactory condition 收集。验收以 `pnpm test` + `tsc --noEmit` + `pnpm tools validate` 全绿为准。

**切片内待补全（非框架缺陷）**：
- interactionSystem：仅日志，无交互语义（待 Slice 1 生存循环）
- inventorySystem：占位，无堆叠/丢弃/使用（待后续切片）
