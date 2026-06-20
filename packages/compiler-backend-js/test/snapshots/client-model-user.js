import { trim } from "../formatters.js";
import { minLength, required } from "../validators.js";

export class User {
    constructor(value) {
        if (value) {
            this.id = value.id;
            this.firstName = value.firstName;
            this.lastName = value.lastName;
        }
    }

    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }
}

User.schema = Object.freeze({
    "name": "user",
    "sourceName": "User",
    "fields": [
        {
            "name": "id",
            "type": {
                "kind": "id"
            },
            "readonly": true,
            "validators": [
                required()
            ]
        },
        {
            "name": "firstName",
            "type": {
                "kind": "string"
            },
            "validators": [
                minLength(2)
            ],
            "formatters": [
                {
                    "phase": "change",
                    "fn": trim()
                }
            ]
        },
        {
            "name": "lastName",
            "type": {
                "kind": "string"
            }
        },
        {
            "name": "fullName",
            "type": {
                "kind": "string"
            },
            "readonly": true,
            "computed": true
        }
    ]
});
