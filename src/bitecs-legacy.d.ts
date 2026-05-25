declare module "bitecs/legacy" {
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

  export function defineComponent<S extends Record<string, unknown>>(
    schema: S,
    max?: number,
  ): {
    [K in keyof S]: any;
  };
}
