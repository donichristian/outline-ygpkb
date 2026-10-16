import { subDays } from "date-fns";
import { Op } from "sequelize";
import { Minute } from "@shared/utils/time";
import userPermanentDeleter from "@server/commands/userPermanentDeleter";
import Logger from "@server/logging/Logger";
import { User } from "@server/models";
import { TaskPriority } from "./base/BaseTask";
import type { Props } from "./base/CronTask";
import { CronTask, TaskInterval } from "./base/CronTask";

/** How long a user's AI chat data is retained after the user is deleted. */
const RetentionDays = 30;

/**
 * Permanently destroys the AI chat data of users deleted longer ago than the
 * retention window. Users are only ever soft deleted, so without this the
 * `ai_chat_sessions` rows of a deleted user would be kept forever.
 */
export default class CleanupDeletedUsersTask extends CronTask {
  public async perform({ limit, partition }: Props) {
    Logger.info(
      "task",
      `Permanently destroying AI chat data for upto ${limit} users older than ${RetentionDays} days…`
    );
    const users = await User.unscoped().findAll({
      attributes: ["id", "deletedAt"],
      where: {
        deletedAt: {
          [Op.lt]: subDays(new Date(), RetentionDays),
        },
        ...this.getPartitionWhereClause("id", partition),
      },
      paranoid: false,
      limit,
    });

    for (const user of users) {
      await userPermanentDeleter(user);
    }
  }

  public get cron() {
    return {
      interval: TaskInterval.Hour,
      partitionWindow: 15 * Minute.ms,
    };
  }

  public get options() {
    return {
      attempts: 1,
      priority: TaskPriority.Background,
    };
  }
}