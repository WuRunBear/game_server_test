/**
 * bitecs legacy API 的类型补全声明（模块扩充，运行时无此文件）。
 *
 * 项目使用 bitecs 的 legacy 入口（bitecs/legacy）：`Types` 类型常量
 * 与 `defineComponent` 工厂本无内建类型，此声明让 TS 获得
 * 「schema → SoA 字段容器」的编译期类型。
 */

declare module "bitecs/legacy" {
  /** 组件 schema 可用的字段类型常量（i8/ui8/i16/.../f64/eid）。 */
  export const Types: {
    i8: "i8";
    ui8: "ui8";
    ui8c: "ui8c";
    i16: "i16";
    ui16: "ui16";
    i32: "i32";
    ui32: "ui32";
    f32: "f32";
    f64: "f64";
    eid: "eid";
  };

  /**
   * 定义组件：按 schema 声明生成「字段名 → 按 eid 索引的数值数组」的
   * 容器对象（SoA 布局）。max 为可选的实体容量上限。
   *
   * @param schema 字段名 → Types 类型常量
   * @param max 可选：预分配的实体数量上限
   */
  export function defineComponent<S extends Record<string, unknown>>(
    schema: S,
    max?: number,
  ): {
    [K in keyof S]: any;
  };
}
