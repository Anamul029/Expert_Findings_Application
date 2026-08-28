import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config'; //

@Injectable()
export class MyDatabaseService {
  constructor(private configService: ConfigService) {}

  getDBUserName(): string {
    return this.configService.get<string>('DB_USER', 'postgres');
  }
}
