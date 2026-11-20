"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "ai_chat_messages" ADD COLUMN IF NOT EXISTS "citationMiss" BOOLEAN NOT NULL DEFAULT false;'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "ai_chat_messages" DROP COLUMN IF EXISTS "citationMiss";'
    );
  },
};
