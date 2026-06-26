import { Schema, Validate, Format, Phase } from "@keyma/schema/dsl";
import { isNegative, isNonPositive, isIpAddress, pattern } from "@keyma/schema/validators";
import { stripNonDigits } from "@keyma/schema/formatters";
import { Entity } from "./base.js";
import { ensureLeadingSlash } from "./lib/formatters.js";

/**
 * A small showcase schema covering the handful of built-in validators/formatters
 * not reached by the core domain, so the generated bundle (and its tests) exercise
 * the full library surface.
 */
@Schema({ name: "showcase", description: "Exercises remaining validators/formatters." })
export class Showcase extends Entity {

    // A price adjustment that is always a reduction.
    @Validate(isNegative())
    adjustment: number = -1;

    @Validate(isNonPositive())
    balance: number = 0;

    // Strip everything but digits as the user types; validate the result.
    @Validate(pattern("^[0-9]+$"))
    @Format(Phase.Change, stripNonDigits())
    declare nationalId?: string;

    // A custom project-local formatter.
    @Format(Phase.Change, ensureLeadingSlash())
    apiPath: string = "/";

    @Validate(isIpAddress("v6"))
    declare ipv6?: string;
}
