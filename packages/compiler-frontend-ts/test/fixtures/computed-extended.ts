import { Schema, Validate } from "@keyma/dsl";
function isRequired() { return { __validatorName: "required" } as const; }

@Schema({ name: "product" })
class Product {
    @Validate(isRequired())
    declare title: string;

    @Validate(isRequired())
    declare price: number;

    declare taxRate: number;

    declare category: string | null;

    declare tags: string[];

    // string literal
    get version(): string {
        return "v1";
    }

    // number literal
    get baseRate(): number {
        return 0;
    }

    // boolean literal
    get isActive(): boolean {
        return true;
    }

    // no-substitution template literal → literal
    get greeting(): string {
        return `hello`;
    }

    // single interpolation → collapses to field reference
    get displayTitle(): string {
        return `${this.title}`;
    }

    // multi-part template
    get summary(): string {
        return `${this.title}: $${this.price}`;
    }

    // binary arithmetic with parenthesized sub-expression
    get priceWithTax(): number {
        return this.price * (1 + this.taxRate);
    }

    // comparison
    get isExpensive(): boolean {
        return this.price > 100;
    }

    // prefix unary negation
    get negatedPrice(): number {
        return -this.price;
    }

    // prefix unary logical not
    get isCheap(): boolean {
        return !this.isExpensive;
    }

    // conditional (ternary)
    get label(): string {
        return this.isExpensive ? "premium" : "budget";
    }

    // nullish coalescing
    get displayCategory(): string {
        return this.category ?? "uncategorized";
    }

    // logical AND
    get isValidPrice(): boolean {
        return this.price > 0 && this.taxRate >= 0;
    }

    // logical OR
    get hasDiscount(): boolean {
        return this.price < 50 || this.taxRate === 0;
    }

    // member access (this.tags.length)
    get tagCount(): number {
        return this.tags.length;
    }
}
