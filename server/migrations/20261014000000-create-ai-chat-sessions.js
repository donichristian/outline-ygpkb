"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Created before ai_chat_messages: the foreign key parent must exist first.
      await queryInterface.createTable(
        "ai_chat_sessions",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: "teams",
              key: "id",
            },
            onDelete: "CASCADE",
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: "users",
              key: "id",
            },
          },
          title: {
            type: Sequelize.STRING(255),
            allowNull: true,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
        },
        { transaction }
      );

      await queryInterface.addIndex(
        "ai_chat_sessions",
        ["teamId", "userId", "updatedAt"],
        { transaction }
      );

      await queryInterface.createTable(
        "ai_chat_messages",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          sessionId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: "ai_chat_sessions",
              key: "id",
            },
            onDelete: "CASCADE",
          },
          role: {
            type: Sequelize.ENUM("user", "assistant"),
            allowNull: false,
          },
          seq: {
            type: Sequelize.INTEGER,
            allowNull: false,
          },
          content: {
            type: Sequelize.TEXT,
            allowNull: false,
          },
          status: {
            type: Sequelize.ENUM("completed", "aborted", "error", "truncated"),
            allowNull: false,
            defaultValue: "completed",
          },
          runId: {
            type: Sequelize.UUID,
            allowNull: true,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
        },
        { transaction }
      );

      // Unique, not plain: this is what makes the row-lock + retry insert
      // strategy safe against a duplicate sequence number on retry.
      await queryInterface.addIndex(
        "ai_chat_messages",
        ["sessionId", "seq"],
        { unique: true, transaction }
      );
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("ai_chat_messages", { transaction });
      await queryInterface.dropTable("ai_chat_sessions", { transaction });

      // Postgres does not drop enum types with their table, so a bare
      // rollback would leave these behind and the next migrate would fail
      // with `type "enum_ai_chat_messages_role" already exists`.
      await queryInterface.sequelize.query(
        'DROP TYPE IF EXISTS "enum_ai_chat_messages_role"',
        { transaction }
      );
      await queryInterface.sequelize.query(
        'DROP TYPE IF EXISTS "enum_ai_chat_messages_status"',
        { transaction }
      );
    });
  },
};
