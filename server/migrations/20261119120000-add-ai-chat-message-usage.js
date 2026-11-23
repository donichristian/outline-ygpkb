"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ai_chat_messages", "prompt_tokens", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("ai_chat_messages", "completion_tokens", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ai_chat_messages", "completion_tokens");
    await queryInterface.removeColumn("ai_chat_messages", "prompt_tokens");
  },
};
