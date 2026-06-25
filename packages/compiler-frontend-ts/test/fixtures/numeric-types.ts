import { Schema } from "@keyma/dsl";
import type { ID, Integer, Unsigned, Float } from "@keyma/dsl";

@Schema({ name: "numeric_types" })
class NumericTypes {
    declare id: ID;
    declare i8: Integer<8>;
    declare i16: Integer<16>;
    declare i32: Integer<32>;
    declare i64: Integer; // default 64 → bits omitted
    declare u8: Unsigned<8>;
    declare u32: Unsigned<32>;
    declare u64: Unsigned; // default 64 → bits omitted, unsigned:true
    declare f: Float; // default 64 → bits omitted
    declare f32: Float<32>;
    declare ints: Integer<16>[];
    declare maybeBig?: Unsigned<64>;
}
