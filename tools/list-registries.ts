import {
  bootstrapFramework,
  listRegisteredSystems,
  listRegisteredArchetypes,
  listRegisteredActions,
  listRegisteredComponents,
  listRegisteredGenerators,
  listRegisteredMapGenerators,
} from "framework";

export function listRegistries(): void {
  bootstrapFramework();

  console.log("=== 已注册的系统 ===");
  for (const sys of listRegisteredSystems()) {
    console.log(`  ${sys.id}`);
  }

  console.log("\n=== 已注册的实体原型 ===");
  for (const arch of listRegisteredArchetypes()) {
    const tags = arch.tags?.length ? ` [${arch.tags.join(", ")}]` : "";
    const behavior = arch.behavior ? ` (behavior: ${arch.behavior})` : "";
    console.log(`  ${arch.kind}${tags}${behavior}`);
  }

  console.log("\n=== 已注册的动作 ===");
  for (const action of listRegisteredActions()) {
    console.log(`  ${action.name}`);
  }

  console.log("\n=== 已注册的组件 ===");
  const components = listRegisteredComponents();
  for (const name of Object.keys(components)) {
    console.log(`  ${name}`);
  }

  console.log("\n=== 已注册的地图生成器 ===");
  const generators = listRegisteredGenerators();
  for (const gen of generators) {
    console.log(`  ${gen.id}`);
  }

  console.log("\n=== 已注册的生成积木 ===");
  for (const block of listRegisteredMapGenerators()) {
    console.log(`  ${block.id}`);
  }
}
