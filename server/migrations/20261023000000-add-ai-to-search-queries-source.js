"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // PostgreSQL allows adding an enum value but never using it in the same
    // transaction that added it. This migration only adds the value and
    // issues no second query, so the rule does not apply. IF NOT EXISTS
    // keeps the statement idempotent on re-runs.
    await queryInterface.sequelize.query(
      "ALTER TYPE enum_search_queries_source ADD VALUE IF NOT EXISTS 'ai'"
    );
  },

  async down(queryInterface, Sequelize) {
    // Note: PostgreSQL doesn't support removing enum values easily
    // This would require recreating the enum type and updating all references
    throw new Error("Cannot rollback adding enum value to PostgreSQL");
  },
};
