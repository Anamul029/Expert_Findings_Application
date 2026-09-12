import { Controller, Get } from '@nestjs/common';
import { LanguagesService } from './languages.service';
import { Language } from './entities/language.entity';

@Controller({ path: 'languages', version: '1' })
export class LanguagesController {
  constructor(private readonly languagesService: LanguagesService) {}

  //  /api/v1/languages
  @Get()
  findAll(): Promise<Language[]> {
    return this.languagesService.findAll();
  }
}
