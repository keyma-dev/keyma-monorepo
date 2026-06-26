import { minLength, required, trim } from "./schema.js";

export class User {
    constructor(value) {
        if (value) {
            this.id = value.id;
            this.firstName = value.firstName;
            this.lastName = value.lastName;
            this.secretNote = value.secretNote;
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
            ],
            "indexes": [
                {
                    "unique": true
                }
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
            "name": "secretNote",
            "type": {
                "kind": "string"
            },
            "visibility": "private",
            "required": false
        }
    ],
    "indexes": [
        {
            "fields": [
                {
                    "name": "firstName",
                    "direction": 1
                }
            ],
            "unique": false
        }
    ]
});
