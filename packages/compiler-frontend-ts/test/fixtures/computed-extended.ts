import { Schema, Validate, Computed } from "@keyma/dsl";
import type { ValidatorFn, Json } from "@keyma/dsl";
function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }

@Schema({ name: "product" })
class Product {
    @Validate(required())
    declare title: string;

    @Validate(required())
    declare price: number;

    declare taxRate: number;

    declare category: string | null;

    declare tags: string[];

    // string literal
    @Computed() get version(): string {
        return "v1";
    }

    // number literal
    @Computed() get baseRate(): number {
        return 0;
    }

    // boolean literal
    @Computed() get isActive(): boolean {
        return true;
    }

    // no-substitution template literal → literal
    @Computed() get greeting(): string {
        return `hello`;
    }

    // single interpolation → collapses to field reference
    @Computed() get displayTitle(): string {
        return `${this.title}`;
    }

    // multi-part template
    @Computed() get summary(): string {
        return `${this.title}: $${this.price}`;
    }

    // binary arithmetic with parenthesized sub-expression
    @Computed() get priceWithTax(): number {
        return this.price * (1 + this.taxRate);
    }

    // comparison
    @Computed() get isExpensive(): boolean {
        return this.price > 100;
    }

    // prefix unary negation
    @Computed() get negatedPrice(): number {
        return -this.price;
    }

    // prefix unary logical not
    @Computed() get isCheap(): boolean {
        return !this.isExpensive;
    }

    // conditional (ternary)
    @Computed() get label(): string {
        return this.isExpensive ? "premium" : "budget";
    }

    // nullish coalescing
    @Computed() get displayCategory(): string {
        return this.category ?? "uncategorized";
    }

    // logical AND
    @Computed() get isValidPrice(): boolean {
        return this.price > 0 && this.taxRate >= 0;
    }

    // logical OR
    @Computed() get hasDiscount(): boolean {
        return this.price < 50 || this.taxRate === 0;
    }

    // array length → intrinsic (type-aware)
    @Computed() get tagCount(): number {
        return this.tags.length;
    }

    // string method intrinsic
    @Computed() get trimmedTitle(): string {
        return this.title.trim();
    }

    // array method intrinsic
    @Computed() get hasPremiumTag(): boolean {
        return this.tags.includes("premium");
    }

    // conditional whose condition is an array intrinsic
    @Computed() get tagBadge(): string {
        return this.tags.includes("sale") ? "ON SALE" : "";
    }

    // typeof operator
    @Computed() get priceType(): string {
        return typeof this.price;
    }
}
